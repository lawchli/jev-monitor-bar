import {test} from 'node:test';
import assert from 'node:assert/strict';
import {builtinModules} from 'node:module';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const root = path.resolve(__dirname, '..');

type Target = {platform: string; arch: string};
type FuseEnum = Record<string, number | string>;

interface PackageConfig {
  APP_ID: string;
  PRODUCT_NAME: string;
  COMPANY_NAME: string;
  COPYRIGHT: string;
  BUNDLE_ID: string;
  SUPPORTED_TARGETS: readonly string[];
  FUSE_SETTINGS: Readonly<Record<string, boolean>>;
  SIGNING_ENV: readonly string[];
  REQUIRED_ASAR_FILES: readonly string[];
  parseTarget(argv: string[]): Target;
  releaseVersions(version: string): {appVersion: string; fileVersion: string; fixedVersion: number[]};
  releaseNames(target: Target & {version: string}): Record<string, string>;
  win32VersionStrings(version: string): Record<string, string>;
  packagerOptions(input: Record<string, unknown>): Record<string, any>;
  appPackageJson(pkg: Record<string, unknown>): Record<string, unknown>;
  shipsDistFile(relative: string): boolean;
  fuseConfig(
    fuseOptions: FuseEnum,
    options: {version: string; resetAdHocDarwinSignature: boolean},
  ): Record<string | number, unknown>;
  fuseMismatches(fuseOptions: FuseEnum, wire: Record<string | number, unknown>): string[];
  signingPlan(input: {env: NodeJS.ProcessEnv; hostPlatform: string; targetPlatform: string}): {
    sign: boolean;
    reason: string;
  };
  bundleRequires(source: string): string[];
  unexpectedRequires(source: string, builtins: readonly string[]): string[];
  asarProblems(entries: string[]): string[];
  manifestExecutionLevel(xml: string): {level?: string; uiAccess?: string; clean: boolean};
  formatSha256Sums(entries: {name: string; hash: string}[]): string;
  parseSha256Sums(text: string): Map<string, string>;
  isReleaseZip(name: string): boolean;
}

async function load(): Promise<PackageConfig> {
  return (await import(pathToFileURL(path.join(root, 'scripts/package-config.mjs')).href)) as PackageConfig;
}

async function loadFuses(): Promise<{FuseV1Options: FuseEnum; FuseVersion: {V1: string}}> {
  return (await import('@electron/fuses')) as unknown as {FuseV1Options: FuseEnum; FuseVersion: {V1: string}};
}

test('parseTarget defaults to win32-x64 and accepts both flag spellings', async () => {
  const config = await load();
  assert.deepEqual(config.parseTarget([]), {platform: 'win32', arch: 'x64'});
  assert.deepEqual(config.parseTarget(['--platform', 'darwin', '--arch', 'arm64']), {
    platform: 'darwin',
    arch: 'arm64',
  });
  assert.deepEqual(config.parseTarget(['--platform=linux', '--arch=x64']), {platform: 'linux', arch: 'x64'});
  assert.deepEqual(config.parseTarget(['--arch', 'arm64']), {platform: 'win32', arch: 'arm64'});
  for (const required of ['win32-x64', 'win32-arm64', 'darwin-arm64', 'linux-x64']) {
    assert.ok(config.SUPPORTED_TARGETS.includes(required), required);
  }
  assert.throws(() => config.parseTarget(['--platform', 'win32', '--arch', 'ia32']), /unsupported target win32-ia32/);
  assert.throws(() => config.parseTarget(['--platform', 'freebsd']), /unsupported target/);
  assert.throws(() => config.parseTarget(['--platform']), /missing value for --platform/);
  assert.throws(() => config.parseTarget(['--platform', '--arch', 'x64']), /missing value for --platform/);
});

test('release versions are numeric x.y.z with a four-part Windows file version', async () => {
  const config = await load();
  assert.deepEqual(config.releaseVersions('0.1.0'), {
    appVersion: '0.1.0',
    fileVersion: '0.1.0.0',
    fixedVersion: [0, 1, 0, 0],
  });
  assert.deepEqual(config.releaseVersions('12.3.45').fixedVersion, [12, 3, 45, 0]);
  for (const bad of ['0.1.0-beta.1', '1.2', '1.2.3.4', 'v1.2.3', '', '70000.0.0']) {
    assert.throws(() => config.releaseVersions(bad), /version/, bad);
  }
});

test('release names are fixed, space-free and carry the version only in the zip name', async () => {
  const config = await load();
  const win = config.releaseNames({version: '0.1.0', platform: 'win32', arch: 'x64'});
  assert.equal(win.dirName, 'jev-monitor-bar-win32-x64');
  assert.equal(win.zipName, 'jev-monitor-bar-0.1.0-win32-x64.zip');
  assert.equal(win.executable, 'jev-monitor-bar.exe');
  assert.equal(win.fuseTarget, 'jev-monitor-bar.exe');
  const mac = config.releaseNames({version: '0.1.0', platform: 'darwin', arch: 'arm64'});
  assert.equal(mac.app, 'JEV Monitor Bar.app');
  assert.equal(mac.executable, 'JEV Monitor Bar.app/Contents/MacOS/JEV Monitor Bar');
  assert.equal(mac.infoPlist, 'JEV Monitor Bar.app/Contents/Info.plist');
  assert.equal(mac.resources, 'JEV Monitor Bar.app/Contents/Resources');
  const linux = config.releaseNames({version: '0.1.0', platform: 'linux', arch: 'x64'});
  assert.equal(linux.executable, 'jev-monitor-bar');
  for (const target of config.SUPPORTED_TARGETS) {
    const [platform, arch] = target.split('-');
    const names = config.releaseNames({version: '0.1.0', platform, arch});
    assert.deepEqual(names, config.releaseNames({version: '0.1.0', platform, arch}));
    assert.match(names.dirName, /^[a-z0-9.-]+$/);
    assert.match(names.zipName, /^[a-z0-9.-]+\.zip$/);
    assert.ok(config.isReleaseZip(names.zipName));
    assert.ok(!names.dirName.includes('0.1.0'));
  }
  assert.ok(!config.isReleaseZip('other-0.1.0-win32-x64.zip'));
  assert.ok(!config.isReleaseZip('jev-monitor-bar-0.1.0-win32-x64.zip.partial'));
});

test('packager options ship a prebuilt asar app without a manifest rewrite', async () => {
  const config = await load();
  const input = {
    appDir: '/stage/app',
    outDir: '/stage/out',
    tmpDir: '/stage/tmp',
    electronVersion: '42.11.6',
    version: '0.1.0',
    checksums: {'electron-v42.11.6-win32-x64.zip': 'abc'},
  };
  const win = config.packagerOptions({...input, platform: 'win32', arch: 'x64'});
  assert.equal(win.asar, true);
  assert.equal(win.prune, false);
  assert.equal(win.tmpdir, '/stage/tmp');
  assert.equal(win.electronVersion, '42.11.6');
  assert.equal(win.executableName, 'jev-monitor-bar');
  assert.equal(win.appVersion, '0.1.0');
  assert.equal(win.buildVersion, '0.1.0.0');
  assert.deepEqual(win.download, {checksums: input.checksums});
  const strings = config.win32VersionStrings('0.1.0');
  for (const key of ['CompanyName', 'FileDescription', 'ProductName', 'InternalName', 'OriginalFilename']) {
    assert.equal(win.win32metadata[key], strings[key], key);
    assert.ok(strings[key]);
  }
  assert.equal(strings.FileVersion, '0.1.0.0');
  assert.equal(strings.ProductVersion, '0.1.0');
  // packager 19.1.1 would write the whole 8 KiB Buffer pool into the manifest; Electron's own manifest is asInvoker.
  assert.ok(!('requested-execution-level' in win.win32metadata));
  assert.ok(!('application-manifest' in win.win32metadata));
  for (const key of ['windowsSign', 'osxSign', 'osxNotarize', 'icon', 'prebuiltAsar', 'extraResource']) {
    assert.ok(!(key in win), key);
  }
  const mac = config.packagerOptions({...input, platform: 'darwin', arch: 'arm64'});
  assert.ok(!('executableName' in mac));
  assert.ok(!('buildVersion' in mac));
  assert.ok(!('win32metadata' in mac));
  assert.equal(mac.appBundleId, 'io.github.lawchli.jev-monitor-bar');
  assert.ok(!('appBundleId' in win));
  // 仓库所有者确认的署名，不再是占位值。
  assert.equal(config.COMPANY_NAME, 'lawchli');
  assert.equal(config.COPYRIGHT, 'Copyright (C) 2026 lawchli');
  assert.equal(win.win32metadata.CompanyName, 'lawchli');
  assert.equal(win.appCopyright, 'Copyright (C) 2026 lawchli');
  const linux = config.packagerOptions({...input, platform: 'linux', arch: 'x64', checksums: undefined});
  assert.equal(linux.executableName, 'jev-monitor-bar');
  assert.deepEqual(linux.download, {});
});

test('the packaged package.json keeps only runtime fields and dist drops source maps', async () => {
  const config = await load();
  const shipped = config.appPackageJson({
    name: 'jev-monitor-bar',
    version: '0.1.0',
    description: 'd',
    main: 'dist/main.cjs',
    scripts: {build: 'x'},
    dependencies: {ajv: '^8'},
    devDependencies: {electron: '^42'},
    packageManager: 'pnpm@11',
  });
  assert.deepEqual(shipped, {
    name: 'jev-monitor-bar',
    productName: 'JEV Monitor Bar',
    version: '0.1.0',
    description: 'd',
    main: 'dist/main.cjs',
    private: true,
  });
  assert.ok(config.shipsDistFile('main.cjs'));
  assert.ok(config.shipsDistFile('renderer/app.js'));
  assert.ok(!config.shipsDistFile('main.cjs.map'));
  assert.ok(!config.shipsDistFile('renderer/app.css.map'));
});

test('fuse config sets every known fuse and closes the debug entry points', async () => {
  const config = await load();
  const {FuseV1Options, FuseVersion} = await loadFuses();
  const built = config.fuseConfig(FuseV1Options, {version: FuseVersion.V1, resetAdHocDarwinSignature: false});
  assert.equal(built.strictlyRequireAllFuses, true);
  assert.equal(built.resetAdHocDarwinSignature, false);
  for (const [name, index] of Object.entries(FuseV1Options)) {
    if (typeof index !== 'number') continue;
    assert.equal(typeof built[index], 'boolean', `fuse ${name} must be set explicitly`);
  }
  const value = (name: string) => built[FuseV1Options[name] as number];
  assert.equal(value('RunAsNode'), false);
  assert.equal(value('EnableNodeOptionsEnvironmentVariable'), false);
  assert.equal(value('EnableNodeCliInspectArguments'), false);
  assert.equal(value('EnableEmbeddedAsarIntegrityValidation'), true);
  assert.equal(value('OnlyLoadAppFromAsar'), true);
  // The renderer loads app://renderer, so file:// no longer needs extra privileges (AUDIT L2).
  assert.equal(value('GrantFileProtocolExtraPrivileges'), false);
  assert.equal(
    config.fuseConfig(FuseV1Options, {version: FuseVersion.V1, resetAdHocDarwinSignature: true})
      .resetAdHocDarwinSignature,
    true,
  );
  const future = {...FuseV1Options, SomeFutureFuse: 99, 99: 'SomeFutureFuse'};
  assert.throws(
    () => config.fuseConfig(future, {version: '1', resetAdHocDarwinSignature: false}),
    /missing for SomeFutureFuse/,
  );
});

test('fuse mismatches read the wire character codes', async () => {
  const config = await load();
  const {FuseV1Options} = await loadFuses();
  const wire: Record<string | number, unknown> = {version: '1'};
  for (const [name, expected] of Object.entries(config.FUSE_SETTINGS)) {
    wire[FuseV1Options[name] as number] = expected ? 49 : 48;
  }
  assert.deepEqual(config.fuseMismatches(FuseV1Options, wire), []);
  wire[FuseV1Options.RunAsNode as number] = 49;
  wire[FuseV1Options.OnlyLoadAppFromAsar as number] = 114;
  delete wire[FuseV1Options.EnableNodeCliInspectArguments as number];
  wire[FuseV1Options.GrantFileProtocolExtraPrivileges as number] = 49;
  assert.deepEqual(config.fuseMismatches(FuseV1Options, wire), [
    'RunAsNode: expected false, got true',
    'EnableNodeCliInspectArguments: expected false, got missing',
    'OnlyLoadAppFromAsar: expected true, got r',
    'GrantFileProtocolExtraPrivileges: expected false, got true',
  ]);
});

test('signing runs only on a Windows host for a win32 target with signing env', async () => {
  const config = await load();
  assert.deepEqual(config.SIGNING_ENV, [
    'WINDOWS_CERTIFICATE_FILE',
    'WINDOWS_SIGN_WITH_PARAMS',
    'WINDOWS_SIGN_HOOK_MODULE_PATH',
  ]);
  const cert = {WINDOWS_CERTIFICATE_FILE: 'C:\\cert.pfx'};
  assert.equal(config.signingPlan({env: {}, hostPlatform: 'win32', targetPlatform: 'win32'}).sign, false);
  assert.equal(
    config.signingPlan({env: {WINDOWS_CERTIFICATE_FILE: ''}, hostPlatform: 'win32', targetPlatform: 'win32'}).sign,
    false,
  );
  const elsewhere = config.signingPlan({env: cert, hostPlatform: 'darwin', targetPlatform: 'win32'});
  assert.equal(elsewhere.sign, false);
  assert.match(elsewhere.reason, /Windows host/);
  assert.equal(config.signingPlan({env: cert, hostPlatform: 'win32', targetPlatform: 'darwin'}).sign, false);
  assert.equal(config.signingPlan({env: cert, hostPlatform: 'win32', targetPlatform: 'win32'}).sign, true);
  assert.equal(
    config.signingPlan({env: {WINDOWS_SIGN_WITH_PARAMS: '/sha1 ab'}, hostPlatform: 'win32', targetPlatform: 'win32'})
      .sign,
    true,
  );
});

test('bundle require scan ignores code-generation strings and flags real externals', async () => {
  const config = await load();
  const source = [
    'var e = require("electron");',
    "var fs = require('node:fs');",
    'var fsp = require("fs/promises");',
    'uri.code = \'require("ajv/dist/runtime/uri").default\';',
    'code: (0, codegen_1._)`require("ajv/dist/runtime/validation_error").default`',
    'obj.require("not-a-module");',
    'var pad = require("left-pad");',
    '(0,require("other"))',
  ].join('\n');
  assert.deepEqual(config.bundleRequires(source), ['electron', 'fs/promises', 'left-pad', 'node:fs', 'other']);
  assert.deepEqual(config.unexpectedRequires(source, builtinModules), ['left-pad', 'other']);
  assert.deepEqual(config.unexpectedRequires('require("electron");require("node:http")', builtinModules), []);
});

test('asar content check wants dist plus package.json and nothing native', async () => {
  const config = await load();
  const good = [
    '/package.json',
    '/dist',
    '/dist/main.cjs',
    '/dist/preload.cjs',
    '/dist/renderer',
    ...config.REQUIRED_ASAR_FILES,
  ];
  assert.deepEqual(config.asarProblems([...new Set(good)]), []);
  assert.deepEqual(config.asarProblems(good.map(entry => entry.replace(/\//g, '\\'))), []);
  const problems = config.asarProblems([
    ...good,
    '/node_modules/ajv/index.js',
    '/dist/main.cjs.map',
    '/dist/addon.node',
    '/src/main/index.ts',
  ]);
  assert.ok(problems.includes('node_modules entry /node_modules/ajv/index.js'));
  assert.ok(problems.includes('source map /dist/main.cjs.map'));
  assert.ok(problems.includes('native addon /dist/addon.node'));
  assert.ok(problems.includes('unexpected /src/main/index.ts'));
  assert.deepEqual(config.asarProblems(['/package.json']).filter(p => p.startsWith('missing')).length, 5);
});

test('manifest check reads the execution level and rejects trailing bytes', async () => {
  const config = await load();
  const manifest =
    '<?xml version="1.0" encoding="UTF-8"?>\n<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">' +
    '<trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges>' +
    '<requestedExecutionLevel level="asInvoker" uiAccess="false"/></requestedPrivileges></security></trustInfo></assembly>';
  assert.deepEqual(config.manifestExecutionLevel(manifest), {level: 'asInvoker', uiAccess: 'false', clean: true});
  assert.equal(config.manifestExecutionLevel(`${manifest}\r\n\0\0`).clean, true);
  assert.equal(config.manifestExecutionLevel(`${manifest}\0garbage\u0001`).clean, false);
  assert.equal(config.manifestExecutionLevel(`\u0007${manifest}`).clean, false);
  assert.equal(
    config.manifestExecutionLevel(manifest.replace('asInvoker', 'requireAdministrator')).level,
    'requireAdministrator',
  );
  assert.equal(config.manifestExecutionLevel('<assembly></assembly>').level, undefined);
});

test('SHA256SUMS uses the coreutils format and round-trips', async () => {
  const config = await load();
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  const text = config.formatSha256Sums([
    {name: 'jev-monitor-bar-0.1.0-win32-x64.zip', hash: b},
    {name: 'jev-monitor-bar-0.1.0-darwin-arm64.zip', hash: a},
  ]);
  assert.equal(text, `${a}  jev-monitor-bar-0.1.0-darwin-arm64.zip\n${b}  jev-monitor-bar-0.1.0-win32-x64.zip\n`);
  const parsed = config.parseSha256Sums(text.replace(/\n/g, '\r\n'));
  assert.equal(parsed.get('jev-monitor-bar-0.1.0-win32-x64.zip'), b);
  assert.equal(config.parseSha256Sums(`${a} *binary.zip\n`).get('binary.zip'), a);
  assert.throws(() => config.parseSha256Sums('not a sum line\n'), /bad SHA256SUMS line/);
});
