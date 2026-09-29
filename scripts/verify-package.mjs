// 读回 release/ 里已生成的发布包并逐项核对：fuses、app.asar 内容与完整性哈希、Windows 版本资源与清单、zip 与目录一致、SHA-256。
// 用法：pnpm package:verify [--platform win32] [--arch x64]
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {builtinModules} from 'node:module';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {extractFile, getRawHeader, listPackage} from '@electron/asar';
import {FuseV1Options, getCurrentFuseWire} from '@electron/fuses';
import plist from 'plist';
import {NtExecutable, NtExecutableResource, Resource} from 'resedit';
import {
  asarProblems,
  fuseMismatches,
  manifestExecutionLevel,
  parseSha256Sums,
  parseTarget,
  releaseNames,
  releaseVersions,
  unexpectedRequires,
  win32VersionStrings,
} from './package-config.mjs';
import {compareTreeWithZip, hashTree, readZipEntries, sha256File} from './release-zip.mjs';

const RT_MANIFEST = 24;
const IMAGE_DIRECTORY_ENTRY_SECURITY = 4;
function readExe(file) {
  const exe = NtExecutable.from(fs.readFileSync(file), {ignoreCert: true});
  return {exe, res: NtExecutableResource.from(exe)};
}

/** Windows exe 的版本资源、清单、ASAR 完整性资源和签名目录。 */
export function readWin32Resources(file) {
  const {exe, res} = readExe(file);
  const [versionInfo] = Resource.VersionInfo.fromEntries(res.entries);
  const [language] = versionInfo.getAllLanguagesForStringValues();
  const fixed = versionInfo.fixedInfo;
  const split = (ms, ls) => [ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff];
  const manifests = res.entries.filter(entry => entry.type === RT_MANIFEST);
  const integrity = res.entries.find(entry => entry.type === 'INTEGRITY' && entry.id === 'ELECTRONASAR');
  const security = exe.newHeader.optionalHeaderDataDirectory.get(IMAGE_DIRECTORY_ENTRY_SECURITY);
  return {
    strings: versionInfo.getStringValues(language),
    fileVersion: split(fixed.fileVersionMS, fixed.fileVersionLS),
    productVersion: split(fixed.productVersionMS, fixed.productVersionLS),
    manifests: manifests.map(entry => Buffer.from(entry.bin).toString('utf8')),
    integrity: integrity ? JSON.parse(Buffer.from(integrity.bin).toString('utf8')) : undefined,
    signed: Boolean(security && security.size > 0),
  };
}

function asarHeaderHash(asarPath) {
  return createHash('sha256').update(getRawHeader(asarPath).headerString).digest('hex');
}

/**
 * 核对一个目标。返回 {ok, lines}；lines 是给人看的逐项结果。
 * `hostPlatform` 只影响 macOS 的 codesign 检查（只能在 macOS 上跑）。
 */
export async function verifyPackage({repoRoot, platform, arch, hostPlatform = process.platform}) {
  const rootPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const version = rootPackage.version;
  const names = releaseNames({version, platform, arch});
  const releaseDir = path.join(repoRoot, 'release');
  const dir = path.join(releaseDir, names.dirName);
  const zipPath = path.join(releaseDir, names.zipName);
  const lines = [];
  const failures = [];
  const check = (label, problems, detail = '') => {
    if (problems.length) {
      failures.push(label);
      lines.push(`FAIL ${label}`);
      for (const problem of problems) lines.push(`     - ${problem}`);
    } else {
      lines.push(`ok   ${label}${detail ? ` (${detail})` : ''}`);
    }
  };

  if (!fs.existsSync(dir)) throw new Error(`missing ${path.relative(repoRoot, dir)}; run pnpm package first`);
  if (!fs.existsSync(zipPath)) throw new Error(`missing ${path.relative(repoRoot, zipPath)}; run pnpm package first`);

  // Fuses
  const wire = await getCurrentFuseWire(path.join(dir, names.fuseTarget));
  const wireLength = Object.keys(wire).filter(key => key !== 'version').length;
  const known = Object.values(FuseV1Options).filter(value => typeof value === 'number').length;
  check(
    'fuses',
    [
      ...fuseMismatches(FuseV1Options, wire),
      ...(wireLength > known ? [`binary has ${wireLength} fuses, @electron/fuses knows ${known}`] : []),
    ],
    `wire v${wire.version}, ${wireLength} fuses`,
  );

  // app.asar
  const resources = path.join(dir, ...names.resources.split('/'));
  const asarPath = path.join(resources, 'app.asar');
  const asarEntries = listPackage(asarPath, {isPack: false});
  const dirEntries = await hashTree(dir);
  const strayFiles = dirEntries
    .filter(
      entry => entry.type === 'file' && (entry.rel.endsWith('.node') || entry.rel.split('/').includes('node_modules')),
    )
    .map(entry => `unexpected ${entry.rel}`);
  const outsideAsar = ['app', 'app.asar.unpacked']
    .filter(name => fs.existsSync(path.join(resources, name)))
    .map(name => `${names.resources}/${name} exists`);
  check(
    'app.asar contents',
    [...asarProblems(asarEntries), ...strayFiles, ...outsideAsar],
    `${asarEntries.length} entries`,
  );
  const requireProblems = [];
  for (const bundle of ['dist/main.cjs', 'dist/preload.cjs']) {
    const source = extractFile(asarPath, bundle).toString('utf8');
    for (const name of unexpectedRequires(source, builtinModules)) requireProblems.push(`${bundle} requires ${name}`);
  }
  check('bundles need only electron and Node built-ins', requireProblems);

  // ASAR 完整性元数据
  const headerHash = asarHeaderHash(asarPath);
  if (platform === 'win32') {
    const exePath = path.join(dir, names.executable);
    const info = readWin32Resources(exePath);
    const integrity = info.integrity ?? [];
    const record = integrity.find(item => item.file.toLowerCase() === 'resources\\app.asar');
    check(
      'asar integrity resource',
      !record
        ? [`no INTEGRITY/ELECTRONASAR entry for resources\\app.asar (${JSON.stringify(integrity)})`]
        : record.alg !== 'SHA256' || record.value !== headerHash
          ? [`recorded ${record.alg}:${record.value}, header hashes to SHA256:${headerHash}`]
          : [],
      `SHA256 ${headerHash.slice(0, 12)}…`,
    );
    const wantStrings = win32VersionStrings(version);
    const stringProblems = Object.entries(wantStrings)
      .filter(([key, value]) => info.strings[key] !== value)
      .map(([key, value]) => `${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(info.strings[key])}`);
    const {fixedVersion} = releaseVersions(version);
    if (info.fileVersion.join('.') !== fixedVersion.join('.')) {
      stringProblems.push(`fixed FileVersion ${info.fileVersion.join('.')}, expected ${fixedVersion.join('.')}`);
    }
    if (info.productVersion.join('.') !== fixedVersion.join('.')) {
      stringProblems.push(`fixed ProductVersion ${info.productVersion.join('.')}, expected ${fixedVersion.join('.')}`);
    }
    check('exe version info', stringProblems, `${wantStrings.ProductName} ${wantStrings.FileVersion}`);
    const manifestProblems = [];
    if (info.manifests.length !== 1) manifestProblems.push(`expected 1 manifest, found ${info.manifests.length}`);
    for (const xml of info.manifests) {
      const parsed = manifestExecutionLevel(xml);
      if (parsed.level !== 'asInvoker') manifestProblems.push(`requestedExecutionLevel ${parsed.level}`);
      if (parsed.uiAccess !== 'false') manifestProblems.push(`uiAccess ${parsed.uiAccess}`);
      if (!parsed.clean) manifestProblems.push('manifest has bytes outside <assembly>…</assembly>');
    }
    check('manifest requestedExecutionLevel', manifestProblems, 'asInvoker, uiAccess=false');
    lines.push(`info Authenticode signature: ${info.signed ? 'present' : 'none (unsigned build)'}`);
  } else if (platform === 'darwin') {
    const infoPlist = plist.parse(fs.readFileSync(path.join(dir, ...names.infoPlist.split('/')), 'utf8'));
    const record = infoPlist.ElectronAsarIntegrity?.['Resources/app.asar'];
    check(
      'asar integrity in Info.plist',
      !record
        ? ['Info.plist has no ElectronAsarIntegrity for Resources/app.asar']
        : record.algorithm !== 'SHA256' || record.hash !== headerHash
          ? [`recorded ${record.algorithm}:${record.hash}, header hashes to SHA256:${headerHash}`]
          : [],
      `SHA256 ${headerHash.slice(0, 12)}…`,
    );
    if (hostPlatform === 'darwin') {
      // macOS：codesign 只在 macOS 主机上可用；这里是打包后的检查，不是应用运行时。
      const result = spawnSync('codesign', ['--verify', '--deep', '--strict', path.join(dir, names.app)], {
        encoding: 'utf8',
      });
      check(
        'codesign --verify --deep --strict',
        result.status === 0 ? [] : [result.stderr.trim() || `status ${result.status}`],
        'ad-hoc',
      );
    } else {
      lines.push('skip codesign verification (needs a macOS host)');
    }
  } else {
    // Linux：未实机验证。Electron 文档只列出 macOS 与 Windows 支持内嵌 ASAR 完整性校验。
    lines.push(
      'info Linux: Electron documents embedded ASAR integrity for macOS and Windows only; nothing to check here',
    );
  }

  // zip 与目录一致
  const zipEntries = await readZipEntries(zipPath);
  check(
    'zip matches directory',
    compareTreeWithZip(dirEntries, zipEntries, names.dirName, {checkModes: platform !== 'win32'}),
    `${zipEntries.length} entries${platform === 'win32' ? '' : ', modes and symlinks preserved'}`,
  );

  // SHA-256
  const zipHash = await sha256File(zipPath);
  const sumsPath = path.join(releaseDir, 'SHA256SUMS.txt');
  const sums = fs.existsSync(sumsPath) ? parseSha256Sums(fs.readFileSync(sumsPath, 'utf8')) : new Map();
  check(
    'SHA256SUMS.txt',
    sums.get(names.zipName) === zipHash
      ? []
      : [`listed ${sums.get(names.zipName) ?? '(none)'}, file hashes to ${zipHash}`],
    `${zipHash}  ${names.zipName}`,
  );

  return {ok: failures.length === 0, lines, zipHash, names};
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  try {
    const {platform, arch} = parseTarget(process.argv.slice(2));
    const result = await verifyPackage({repoRoot, platform, arch});
    console.log(`verify ${platform}-${arch}`);
    for (const line of result.lines) console.log(`  ${line}`);
    if (!result.ok) process.exit(1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
