// 发布目录与目录 zip 的读写。纯 JS（yazl / yauzl），在 Windows、macOS、Linux 主机上行为一致。
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import yauzl from 'yauzl';
import yazl from 'yazl';

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/** 目录树（不跟随符号链接），相对路径统一用 `/`，按字典序排好。 */
export function walkTree(root) {
  const entries = [];
  const visit = relative => {
    const full = relative ? path.join(root, ...relative.split('/')) : root;
    for (const name of fs.readdirSync(full).sort()) {
      const rel = relative ? `${relative}/${name}` : name;
      const abs = path.join(full, name);
      const stat = fs.lstatSync(abs);
      if (stat.isSymbolicLink()) {
        entries.push({rel, type: 'symlink', mode: stat.mode, mtime: stat.mtime, target: fs.readlinkSync(abs)});
      } else if (stat.isDirectory()) {
        entries.push({rel, type: 'dir', mode: stat.mode, mtime: stat.mtime});
        visit(rel);
      } else if (stat.isFile()) {
        entries.push({rel, type: 'file', mode: stat.mode, mtime: stat.mtime, size: stat.size});
      } else {
        throw new Error(`unsupported file type at ${abs}`);
      }
    }
  };
  visit('');
  return entries;
}

export async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * 把 `dir` 打成 zip，顶层是名为 `topName` 的目录。保留 unix 权限位和符号链接（macOS .app 里的 framework 依赖它们）。
 * `mtime` 给定时所有条目用同一个时间（SOURCE_DATE_EPOCH），否则用文件自己的修改时间。先写 `.partial` 再改名。
 */
export async function writeDirectoryZip(dir, topName, zipPath, {mtime} = {}) {
  const zip = new yazl.ZipFile();
  const top = fs.lstatSync(dir);
  zip.addEmptyDirectory(topName, {mode: top.mode, mtime: mtime ?? top.mtime});
  for (const entry of walkTree(dir)) {
    const name = `${topName}/${entry.rel}`;
    const options = {mode: entry.mode, mtime: mtime ?? entry.mtime};
    if (entry.type === 'dir') zip.addEmptyDirectory(name, options);
    else if (entry.type === 'symlink')
      zip.addBuffer(Buffer.from(entry.target, 'utf8'), name, {...options, compress: false});
    else zip.addFile(path.join(dir, ...entry.rel.split('/')), name, {...options, compress: true});
  }
  zip.end();
  const partial = `${zipPath}.partial`;
  await pipeline(zip.outputStream, fs.createWriteStream(partial));
  return partial;
}

function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, {lazyEntries: true, validateEntrySizes: true, strictFileNames: true}, (error, zip) =>
      error ? reject(error) : resolve(zip),
    );
  });
}

/** zip 条目：名字、类型、unix 权限位、内容 SHA-256（文件）或链接目标（符号链接）。 */
export async function readZipEntries(file) {
  const zip = await openZip(file);
  const entries = [];
  try {
    await new Promise((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', entry => {
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if (entry.fileName.endsWith('/')) {
          entries.push({name: entry.fileName.slice(0, -1), type: 'dir', mode});
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (error, stream) => {
          if (error) return reject(error);
          const hash = createHash('sha256');
          const chunks = [];
          const symlink = (mode & S_IFMT) === S_IFLNK;
          stream.on('data', chunk => {
            hash.update(chunk);
            if (symlink) chunks.push(chunk);
          });
          stream.on('error', reject);
          stream.on('end', () => {
            entries.push(
              symlink
                ? {name: entry.fileName, type: 'symlink', mode, target: Buffer.concat(chunks).toString('utf8')}
                : {name: entry.fileName, type: 'file', mode, size: entry.uncompressedSize, sha256: hash.digest('hex')},
            );
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  return entries;
}

/**
 * 目录树（带 sha256）与 zip 条目逐项比对，返回问题列表。`checkModes` 为真时比较 0o777 权限位（Windows 目标不比）。
 */
export function compareTreeWithZip(dirEntries, zipEntries, topName, {checkModes}) {
  const problems = [];
  const expected = new Map([[topName, {type: 'dir'}]]);
  for (const entry of dirEntries) expected.set(`${topName}/${entry.rel}`, entry);
  const actual = new Map();
  for (const entry of zipEntries) {
    if (entry.name.startsWith('/') || entry.name.split('/').includes('..')) problems.push(`unsafe entry ${entry.name}`);
    if (actual.has(entry.name)) problems.push(`duplicate entry ${entry.name}`);
    actual.set(entry.name, entry);
  }
  for (const name of expected.keys()) if (!actual.has(name)) problems.push(`zip is missing ${name}`);
  for (const name of actual.keys()) if (!expected.has(name)) problems.push(`zip has extra ${name}`);
  for (const [name, want] of expected) {
    const got = actual.get(name);
    if (!got) continue;
    if (got.type !== want.type) {
      problems.push(`${name}: ${got.type} in zip, ${want.type} on disk`);
      continue;
    }
    if (want.type === 'file' && (got.size !== want.size || got.sha256 !== want.sha256)) {
      problems.push(`${name}: content differs`);
    }
    if (want.type === 'symlink' && got.target !== want.target) problems.push(`${name}: link target differs`);
    if (checkModes && want.mode !== undefined && (got.mode & 0o777) !== (want.mode & 0o777)) {
      problems.push(
        `${name}: mode ${(got.mode & 0o777).toString(8)} in zip, ${(want.mode & 0o777).toString(8)} on disk`,
      );
    }
  }
  return problems;
}

/** 目录树加上每个文件的 SHA-256，供 compareTreeWithZip 使用。 */
export async function hashTree(dir) {
  const entries = walkTree(dir);
  for (const entry of entries) {
    if (entry.type === 'file') entry.sha256 = await sha256File(path.join(dir, ...entry.rel.split('/')));
  }
  return entries;
}
