// 发布打包：构建 → 整理最小 app 目录 → @electron/packager → fuses → （可选）签名 → 目录 zip → SHA256SUMS.txt → 读回核对。
// 用法：pnpm package [--platform win32|darwin|linux] [--arch x64|arm64]，默认 win32-x64。
// 首版发布为解压即用的目录 zip：不做单文件便携版、自解压、UPX 或混淆。
import fs from 'node:fs';
import {builtinModules, createRequire} from 'node:module';
import path from 'node:path';
import {FuseV1Options, FuseVersion, flipFuses} from '@electron/fuses';
import {packager} from '@electron/packager';
import {
  appPackageJson,
  formatSha256Sums,
  fuseConfig,
  isReleaseZip,
  packagerOptions,
  parseTarget,
  PRODUCT_NAME,
  releaseNames,
  shipsDistFile,
  signingPlan,
  unexpectedRequires,
} from './package-config.mjs';
import {sha256File, walkTree, writeDirectoryZip} from './release-zip.mjs';
import {verifyPackage} from './verify-package.mjs';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const releaseDir = path.join(repoRoot, 'release');

function fail(message) {
  console.error(message);
  process.exit(1);
}

// Windows：未实机验证。杀毒软件可能短暂占用刚解出的文件，rename 遇到 EPERM / EBUSY / EACCES 时重试。
async function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 250 * attempt));
    }
  }
}
const removeOptions = {recursive: true, force: true, maxRetries: 10, retryDelay: 250};

let target;
try {
  target = parseTarget(process.argv.slice(2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const {platform, arch} = target;
const rootPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const version = rootPackage.version;
const names = releaseNames({version, platform, arch});
const electronPackage = require('electron/package.json');
const checksums = require('electron/checksums.json');
const stage = path.join(releaseDir, '.stage', `${platform}-${arch}`);
const finalDir = path.join(releaseDir, names.dirName);
const zipPath = path.join(releaseDir, names.zipName);

console.log(`package ${names.dirName} (app ${version}, electron ${electronPackage.version})`);

// 1. 构建。渲染端用 React 生产构建。
process.env.JEV_BUILD_MODE = 'production';
await import('./build.mjs');

// 2. 最小 app 目录：dist（不含 source map）+ 只有运行时字段的 package.json。不带 node_modules。
fs.rmSync(stage, removeOptions);
const appDir = path.join(stage, 'app');
const distDir = path.join(repoRoot, 'dist');
for (const entry of walkTree(distDir)) {
  if (entry.type !== 'file' || !shipsDistFile(entry.rel)) continue;
  const to = path.join(appDir, 'dist', ...entry.rel.split('/'));
  fs.mkdirSync(path.dirname(to), {recursive: true});
  fs.copyFileSync(path.join(distDir, ...entry.rel.split('/')), to);
}
fs.writeFileSync(path.join(appDir, 'package.json'), `${JSON.stringify(appPackageJson(rootPackage), null, 2)}\n`);
for (const bundle of ['main.cjs', 'preload.cjs']) {
  const extra = unexpectedRequires(fs.readFileSync(path.join(appDir, 'dist', bundle), 'utf8'), builtinModules);
  if (extra.length) fail(`dist/${bundle} still requires ${extra.join(', ')}; bundle them or ship them`);
}

// 3. packager。临时目录放在 release/.stage 下，不和别的打包进程共用系统临时目录里的 electron-packager。
// Electron zip 按 electron 包自带的 checksums.json 校验（版本由锁文件固定）。
const [packagedDir] = await packager(
  packagerOptions({
    appDir,
    outDir: path.join(stage, 'out'),
    tmpDir: path.join(stage, 'tmp'),
    platform,
    arch,
    electronVersion: electronPackage.version,
    version,
    checksums,
  }),
);
if (!packagedDir) fail('packager produced no output');
fs.rmSync(finalDir, removeOptions);
await renameWithRetry(packagedDir, finalDir);
// packager 的暂存目录由 mkdtemp 建成 0700；发布目录按常规 0755，解压后别的用户也能运行。
fs.chmodSync(finalDir, 0o755);

// 4. Fuses，必须在任何签名之前。macOS arm64 改了二进制后要重做 ad-hoc 签名，否则无法启动。
// macOS：codesign 只在 macOS 主机上可用。在别的主机上打 darwin 包，只翻 fuses 并提示。
const darwinResign = platform === 'darwin' && process.platform === 'darwin';
await flipFuses(
  path.join(finalDir, ...names.fuseTarget.split('/')),
  fuseConfig(FuseV1Options, {version: FuseVersion.V1, resetAdHocDarwinSignature: darwinResign}),
);
if (platform === 'darwin' && !darwinResign) {
  console.warn(
    'WARNING: darwin package built on a non-macOS host; the ad-hoc signature was not reset and arm64 will refuse to launch it.',
  );
}

// 5. 签名（可选）。只在 Windows 主机、提供了签名环境变量时进行；证书不进仓库。
const plan = signingPlan({env: process.env, hostPlatform: process.platform, targetPlatform: platform});
let signed = false;
if (plan.sign) {
  // Windows：未实机验证。@electron/windows-sign 读 WINDOWS_CERTIFICATE_FILE / WINDOWS_CERTIFICATE_PASSWORD /
  // WINDOWS_SIGN_WITH_PARAMS / WINDOWS_TIMESTAMP_SERVER / WINDOWS_SIGN_HOOK_MODULE_PATH，签目录里全部 exe/dll。
  const {sign} = await import('@electron/windows-sign');
  await sign({appDirectory: finalDir, hashes: ['sha256'], description: PRODUCT_NAME});
  signed = true;
}

// 6. 目录 zip。顶层是固定名字的目录；保留 unix 权限位和符号链接。设了 SOURCE_DATE_EPOCH 就用它做所有条目的时间。
const epoch = process.env.SOURCE_DATE_EPOCH ? Number(process.env.SOURCE_DATE_EPOCH) : NaN;
const mtime = Number.isFinite(epoch) ? new Date(epoch * 1000) : undefined;
await renameWithRetry(await writeDirectoryZip(finalDir, names.dirName, zipPath, {mtime}), zipPath);

// 7. SHA256SUMS.txt：按 release/ 里现有的本项目 zip 重算。
const sums = [];
for (const name of fs.readdirSync(releaseDir).filter(isReleaseZip)) {
  sums.push({name, hash: await sha256File(path.join(releaseDir, name))});
}
fs.writeFileSync(path.join(releaseDir, 'SHA256SUMS.txt'), formatSha256Sums(sums));
fs.rmSync(stage, removeOptions);
try {
  fs.rmdirSync(path.dirname(stage));
} catch {
  // 另一个目标还在打包，或者目录不空：留着。
}

// 8. 读回核对。
const result = await verifyPackage({repoRoot, platform, arch});
for (const line of result.lines) console.log(`  ${line}`);
const size = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
console.log(`\n${path.relative(repoRoot, finalDir)}/`);
console.log(`${path.relative(repoRoot, zipPath)} (${size} MiB)`);
console.log(`sha256 ${result.zipHash}`);
if (signed) {
  console.log(`signed: ${plan.reason}`);
} else if (platform === 'win32') {
  console.log(`\nUNSIGNED BUILD (${plan.reason}).`);
  console.log(
    'Windows SmartScreen will warn on first run. Publish SHA256SUMS.txt next to the zip so users can check it:',
  );
  console.log(`  PowerShell: Get-FileHash -Algorithm SHA256 ${names.zipName}`);
} else if (platform === 'darwin') {
  console.log(
    `\nNOT NOTARIZED: ${darwinResign ? 'ad-hoc signed only' : 'ad-hoc signature not reset'}. Gatekeeper will block a downloaded copy.`,
  );
}
if (!result.ok) fail('package verification failed');
