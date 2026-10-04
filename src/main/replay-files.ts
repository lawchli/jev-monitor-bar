import fs from 'node:fs';
import {StringDecoder} from 'node:string_decoder';
import {REPLAY_MAX_BYTES} from '../replay';
import type {ReplayReadResult} from './ipc-api';

const READ_CHUNK_BYTES = 64 * 1024;

function readError(error: unknown): ReplayReadResult {
  return {ok: false, reason: 'read-error', message: error instanceof Error ? error.message : String(error)};
}

function readDescriptor(fd: number, maxBytes: number): ReplayReadResult {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile()) return {ok: false, reason: 'read-error', message: '不是文件'};
  if (stat.size > maxBytes) return {ok: false, reason: 'too-large'};

  const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes + 1));
  const decoder = new StringDecoder('utf8');
  const parts: string[] = [];
  let bytes = 0;
  while (bytes <= maxBytes) {
    // Read one extra byte to detect growth without trusting the earlier file size.
    const length = Math.min(chunk.length, maxBytes + 1 - bytes);
    const count = fs.readSync(fd, chunk, 0, length, null);
    if (count === 0) {
      parts.push(decoder.end());
      return {ok: true, text: parts.join('')};
    }
    bytes += count;
    if (bytes > maxBytes) return {ok: false, reason: 'too-large'};
    parts.push(decoder.write(chunk.subarray(0, count)));
  }
  return {ok: false, reason: 'too-large'};
}

/** The selected path is opened once; its descriptor is inspected and read within the byte cap. */
export function readReplayFile(file: string, maxBytes = REPLAY_MAX_BYTES): ReplayReadResult {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= Number.MAX_SAFE_INTEGER) {
    return readError(new RangeError('Invalid replay byte limit'));
  }
  let fd: number | undefined;
  let result: ReplayReadResult;
  try {
    // Nonblocking open lets fstat reject a FIFO without waiting for another process to write it.
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    result = readDescriptor(fd, maxBytes);
  } catch (error) {
    result = readError(error);
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (error) {
        result = readError(error);
      }
    }
  }
  return result;
}
