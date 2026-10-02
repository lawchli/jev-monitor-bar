// 发布打包的纯函数与常量。scripts/package.mjs 和 scripts/verify-package.mjs 共用，tests/package-config.test.ts 直接测试。
// 这里不读写文件、不启动进程，也不依赖 electron 相关包，CI 跳过 Electron 下载时也能测。

export const APP_ID = 'jev-monitor-bar';
export const PRODUCT_NAME = 'JEV Monitor Bar';
// CompanyName、LegalCopyright 与 macOS bundle id 由仓库所有者确认（2026-09-30）：项目没有公司，用 GitHub 账号名。
// 不填 CompanyName 时 Electron 原有的 GitHub, Inc. 字样会留在 exe 里。
export const COMPANY_NAME = 'lawchli';
export const COPYRIGHT = 'Copyright (C) 2026 lawchli';
export const BUNDLE_ID = 'io.github.lawchli.jev-monitor-bar';

export const SUPPORTED_TARGETS = Object.freeze([
  'win32-x64',
  'win32-arm64',
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'linux-arm64',
]);

export const DEFAULT_TARGET = Object.freeze({platform: 'win32', arch: 'x64'});

/** 读 `--platform <p>` / `--arch <a>`（也接受 `--platform=p`）。默认 win32-x64。 */
export function parseTarget(argv) {
  const read = name => {
    let value;
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === `--${name}`) {
        value = argv[i + 1];
        if (!value || value.startsWith('--')) throw new Error(`missing value for --${name}`);
        i++;
      } else if (arg.startsWith(`--${name}=`)) {
        value = arg.slice(name.length + 3);
        if (!value) throw new Error(`missing value for --${name}`);
      }
    }
    return value;
  };
  const platform = read('platform') ?? DEFAULT_TARGET.platform;
  const arch = read('arch') ?? DEFAULT_TARGET.arch;
  if (!SUPPORTED_TARGETS.includes(`${platform}-${arch}`)) {
    throw new Error(`unsupported target ${platform}-${arch}; expected one of ${SUPPORTED_TARGETS.join(', ')}`);
  }
  return {platform, arch};
}

/**
 * 包的版本只接受 x.y.z：Windows 的 FileVersion/ProductVersion 数字字段和 macOS 的 CFBundleShortVersionString 都只收数字。
 * Windows FileVersion 用四段（补 .0）；macOS CFBundleVersion 最多三段，所以四段只给 win32。
 */
export function releaseVersions(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
  if (!match) throw new Error(`package.json version must be x.y.z for packaging, got ${JSON.stringify(version)}`);
  const parts = match.slice(1).map(Number);
  if (parts.some(part => part > 65535)) throw new Error(`version component above 65535 in ${version}`);
  return {appVersion: version, fileVersion: `${version}.0`, fixedVersion: [...parts, 0]};
}

/** 发布物的固定名字。目录名不带版本，解压覆盖升级时路径不变；zip 名带版本。 */
export function releaseNames({version, platform, arch}) {
  const dirName = `${APP_ID}-${platform}-${arch}`;
  const zipName = `${APP_ID}-${version}-${platform}-${arch}.zip`;
  if (platform === 'win32') {
    return {dirName, zipName, executable: `${APP_ID}.exe`, fuseTarget: `${APP_ID}.exe`, resources: 'resources'};
  }
  if (platform === 'darwin') {
    // macOS 按惯例用产品名做 .app 和可执行文件名。
    const app = `${PRODUCT_NAME}.app`;
    return {
      dirName,
      zipName,
      app,
      executable: `${app}/Contents/MacOS/${PRODUCT_NAME}`,
      fuseTarget: app,
      resources: `${app}/Contents/Resources`,
      infoPlist: `${app}/Contents/Info.plist`,
    };
  }
  return {dirName, zipName, executable: APP_ID, fuseTarget: APP_ID, resources: 'resources'};
}

/** 写进 exe 版本资源的字符串。键名与 VS_VERSIONINFO StringFileInfo 一致。 */
export function win32VersionStrings(version) {
  const {appVersion, fileVersion} = releaseVersions(version);
  return {
    CompanyName: COMPANY_NAME,
    FileDescription: PRODUCT_NAME,
    ProductName: PRODUCT_NAME,
    InternalName: APP_ID,
    OriginalFilename: `${APP_ID}.exe`,
    FileVersion: fileVersion,
    ProductVersion: appVersion,
    LegalCopyright: COPYRIGHT,
  };
}

/**
 * @electron/packager 的选项。app 目录是预先整理好的 dist + 最小 package.json，所以不需要 prune 和 ignore。
 * 不传 win32metadata['requested-execution-level']：packager 19.1.1 改清单时写入 `Buffer.from(str).buffer`，
 * 小于 4 KiB 的字符串会带出整块 8 KiB 缓冲池，清单被写坏。Electron 自带清单本来就是 asInvoker，由 verify 读回确认。
 */
export function packagerOptions({appDir, outDir, tmpDir, platform, arch, electronVersion, version, checksums}) {
  const {appVersion, fileVersion} = releaseVersions(version);
  const options = {
    dir: appDir,
    out: outDir,
    tmpdir: tmpDir,
    platform,
    arch,
    electronVersion,
    name: PRODUCT_NAME,
    appVersion,
    appCopyright: COPYRIGHT,
    asar: true,
    prune: false,
    overwrite: true,
    quiet: true,
    download: checksums ? {checksums} : {},
  };
  // Windows / Linux 的可执行文件名不带空格；macOS 保持产品名（见 releaseNames）。
  if (platform !== 'darwin') options.executableName = APP_ID;
  // 不设时 packager 用 com.electron.<name>。
  if (platform === 'darwin') options.appBundleId = BUNDLE_ID;
  if (platform === 'win32') {
    const strings = win32VersionStrings(version);
    options.buildVersion = fileVersion;
    options.win32metadata = {
      CompanyName: strings.CompanyName,
      FileDescription: strings.FileDescription,
      ProductName: strings.ProductName,
      InternalName: strings.InternalName,
      OriginalFilename: strings.OriginalFilename,
    };
  }
  return options;
}

/** 装进 app.asar 的 package.json：只留运行时需要的字段，没有依赖和脚本。 */
export function appPackageJson(rootPackage) {
  return {
    name: rootPackage.name,
    productName: PRODUCT_NAME,
    version: rootPackage.version,
    description: rootPackage.description,
    main: rootPackage.main,
    private: true,
  };
}

/** dist 里哪些文件进包。source map 不进：体积大，并且带本机源码路径。 */
export function shipsDistFile(relativePath) {
  return !relativePath.endsWith('.map');
}

/**
 * Electron fuses。按名字写，由调用方映射到 @electron/fuses 的 FuseV1Options，并开 strictlyRequireAllFuses：
 * Electron 以后加了新 fuse 而这里没写，打包直接失败，逼着人看一眼。
 */
export const FUSE_SETTINGS = Object.freeze({
  // 关掉 ELECTRON_RUN_AS_NODE，发布包不能当 node 跑任意脚本。
  RunAsNode: false,
  // 应用不用 cookie；开了会在 macOS 钥匙串、Linux libsecret 建条目，换不来什么。
  EnableCookieEncryption: false,
  // 忽略 NODE_OPTIONS / NODE_EXTRA_CA_CERTS 等环境变量注入。
  EnableNodeOptionsEnvironmentVariable: false,
  // 忽略 --inspect / --inspect-brk 等调试参数。
  EnableNodeCliInspectArguments: false,
  // 校验 app.asar 与 exe 资源（Windows）或 Info.plist（macOS）里记录的哈希。Electron 文档只列 macOS、Windows；Linux 未实机验证。
  EnableEmbeddedAsarIntegrityValidation: true,
  // 只从 app.asar 加载，不认 resources/app 目录。
  OnlyLoadAppFromAsar: true,
  // 默认值：不用浏览器进程专用 V8 快照。
  LoadBrowserProcessSpecificV8Snapshot: false,
  // 渲染页改由 app://renderer 加载，主进程通过 fs 读取 ASAR 内受限的静态资源（AUDIT L2）。
  // file:// 不需要额外特权，也不能再直接读取 app.asar 内部。
  GrantFileProtocolExtraPrivileges: false,
  // 默认值：保留 WebAssembly trap handler。
  WasmTrapHandlers: true,
});

/** 把 FUSE_SETTINGS 映射成 @electron/fuses 的配置。`fuseOptions` 传入 FuseV1Options 枚举。 */
export function fuseConfig(fuseOptions, {version, resetAdHocDarwinSignature}) {
  const config = {
    version,
    strictlyRequireAllFuses: true,
    resetAdHocDarwinSignature: Boolean(resetAdHocDarwinSignature),
  };
  for (const [name, value] of Object.entries(FUSE_SETTINGS)) {
    const index = fuseOptions[name];
    if (typeof index !== 'number') throw new Error(`unknown fuse ${name}`);
    config[index] = value;
  }
  const known = Object.values(fuseOptions).filter(value => typeof value === 'number');
  const missing = known.filter(index => !(index in config)).map(index => fuseOptions[index]);
  if (missing.length) throw new Error(`fuse settings missing for ${missing.join(', ')}`);
  return config;
}

/** 读回的 fuse wire（字符码）与 FUSE_SETTINGS 比对，返回不一致项。 */
export function fuseMismatches(fuseOptions, wire) {
  const problems = [];
  for (const [name, expected] of Object.entries(FUSE_SETTINGS)) {
    const index = fuseOptions[name];
    const code = wire[index];
    const actual =
      code === 49 ? true : code === 48 ? false : code === undefined ? 'missing' : String.fromCharCode(code);
    if (actual !== expected) problems.push(`${name}: expected ${expected}, got ${actual}`);
  }
  return problems;
}

/** 签名计划。只有 Windows 主机、win32 目标、且提供了签名环境变量时才签。 */
export const SIGNING_ENV = Object.freeze([
  'WINDOWS_CERTIFICATE_FILE',
  'WINDOWS_SIGN_WITH_PARAMS',
  'WINDOWS_SIGN_HOOK_MODULE_PATH',
]);

export function signingPlan({env, hostPlatform, targetPlatform}) {
  const provided = SIGNING_ENV.filter(name => Boolean(env[name]));
  if (targetPlatform !== 'win32') {
    return {sign: false, reason: `${targetPlatform} target: Authenticode signing does not apply`};
  }
  if (!provided.length) return {sign: false, reason: `none of ${SIGNING_ENV.join(', ')} is set`};
  if (hostPlatform !== 'win32') {
    return {sign: false, reason: `${provided.join(', ')} set, but signing runs only on a Windows host`};
  }
  return {sign: true, reason: `signing with ${provided.join(', ')}`};
}

/**
 * 找出打包后的 CommonJS 里真正的 require("x")。前面是引号或反引号的算字符串（ajv 生成代码的模板），不算。
 */
export function bundleRequires(source) {
  const found = new Set();
  const pattern = /(^|[^`'"\w$.])require\((["'])([^"'`]+)\2\)/g;
  for (const match of source.matchAll(pattern)) found.add(match[3]);
  return [...found].sort();
}

/** 除了 electron 和 Node 内置模块以外的 require。非空表示包里缺依赖。 */
export function unexpectedRequires(source, builtinModules) {
  const builtins = new Set(builtinModules);
  return bundleRequires(source).filter(name => {
    if (name === 'electron') return false;
    const bare = name.startsWith('node:') ? name.slice(5) : name;
    return !builtins.has(bare) && !builtins.has(bare.split('/')[0]);
  });
}

/** app.asar 里的条目检查。条目是 @electron/asar listPackage 的结果（以 / 或 \ 开头）。 */
export const REQUIRED_ASAR_FILES = Object.freeze([
  '/package.json',
  '/dist/main.cjs',
  '/dist/preload.cjs',
  '/dist/renderer/index.html',
  '/dist/renderer/app.js',
  '/dist/renderer/app.css',
]);

export function asarProblems(entries) {
  const normalized = entries.map(entry => entry.replace(/\\/g, '/'));
  const problems = [];
  for (const required of REQUIRED_ASAR_FILES) {
    if (!normalized.includes(required)) problems.push(`missing ${required}`);
  }
  for (const entry of normalized) {
    if (entry.endsWith('.node')) problems.push(`native addon ${entry}`);
    if (entry.split('/').includes('node_modules')) problems.push(`node_modules entry ${entry}`);
    if (entry.endsWith('.map')) problems.push(`source map ${entry}`);
    if (entry !== '/package.json' && entry !== '/dist' && !entry.startsWith('/dist/'))
      problems.push(`unexpected ${entry}`);
  }
  return problems;
}

/** Windows 清单里的 requestedExecutionLevel，并检查 XML 后面没有夹带垃圾字节。 */
export function manifestExecutionLevel(xml) {
  const trimmed = xml.replace(/[\s\0]+$/, '');
  const clean = trimmed.startsWith('<') && trimmed.endsWith('</assembly>');
  const match = /<requestedExecutionLevel\b[^>]*\blevel="([^"]+)"[^>]*\/?>/.exec(xml);
  const uiAccess = match ? /\buiAccess="([^"]+)"/.exec(match[0])?.[1] : undefined;
  return {level: match?.[1], uiAccess, clean};
}

/** GNU coreutils 格式（两个空格），`sha256sum -c` 与 `shasum -a 256 -c` 都能读。 */
export function formatSha256Sums(entries) {
  return (
    [...entries]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map(({hash, name}) => `${hash}  ${name}`)
      .join('\n') + '\n'
  );
}

export function parseSha256Sums(text) {
  const result = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!match) throw new Error(`bad SHA256SUMS line: ${line}`);
    result.set(match[2], match[1]);
  }
  return result;
}

/** 发布 zip 的判定：本项目、任意版本、任意目标。SHA256SUMS.txt 按目录里现有的这些 zip 重算。 */
export function isReleaseZip(name) {
  return name.startsWith(`${APP_ID}-`) && name.endsWith('.zip');
}
