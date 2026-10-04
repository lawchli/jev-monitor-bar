import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {readBoundedTextFile} from './read-file';

const retryable = new Set(['EPERM', 'EBUSY', 'EACCES']);
export const SESSION_MAX_BYTES = 16 * 1024;

function waitMs(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function writeSessionFile(file: string, session: {url: string; token: string}) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const tmp = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(session), {mode: 0o600});
    const maxRetries = 5;
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, file);
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (attempt >= maxRetries || !code || !retryable.has(code)) throw err;
        // Retry n waits 20×n ms before the nth attempt to replace a locked session file.
        waitMs(20 * (attempt + 1));
      }
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // A partial temporary write also needs cleanup; preserve the original write or rename error.
    }
    throw err;
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // chmod is a no-op on some platforms; the mode passed to writeFileSync still applies where it is honored.
  }
}

export function readSessionFile(file: string): {url: string; token: string} | undefined {
  try {
    const parsed = JSON.parse(readBoundedTextFile(file, SESSION_MAX_BYTES)) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const {url, token} = parsed as {url?: unknown; token?: unknown};
    if (typeof url !== 'string' || typeof token !== 'string') return undefined;
    return {url, token};
  } catch {
    return undefined;
  }
}

function lookAtSession(file: string): {token?: string; code?: string} {
  try {
    const parsed = JSON.parse(readBoundedTextFile(file, SESSION_MAX_BYTES)) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const token = (parsed as {token?: unknown}).token;
    return typeof token === 'string' ? {token} : {};
  } catch (err) {
    return {code: (err as NodeJS.ErrnoException).code};
  }
}

export function removeSessionFileIfOwned(file: string, token: string) {
  const maxRetries = 5;
  for (let attempt = 0; ; attempt++) {
    const seen = lookAtSession(file);
    if (seen.code === 'ENOENT' || (seen.token !== undefined && seen.token !== token)) return;
    const locked = seen.code !== undefined && retryable.has(seen.code);
    if (seen.token !== token) {
      if (!locked || attempt >= maxRetries) {
        if (locked) throw Object.assign(new Error('Session file is locked'), {code: seen.code});
        return;
      }
    } else {
      try {
        fs.unlinkSync(file);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return;
        if (attempt >= maxRetries || !code || !retryable.has(code)) throw err;
      }
    }
    // Re-read before the next try so a replaced token is left alone.
    waitMs(20 * (attempt + 1));
  }
}
