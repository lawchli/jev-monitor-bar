import fs from 'node:fs';
import {StringDecoder} from 'node:string_decoder';

const READ_CHUNK_BYTES = 4096;

/** Read a regular file through one descriptor, allowing at most one byte beyond the cap. */
export function readBoundedTextFile(file: string, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError('Invalid file byte limit');
  }
  // Nonblocking open lets fstat reject a FIFO without waiting for a writer.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  let failed = false;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('Expected a regular file');
    if (stat.size > maxBytes) throw new RangeError('File exceeds byte limit');

    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes + 1));
    const decoder = new StringDecoder('utf8');
    const parts: string[] = [];
    let bytes = 0;
    while (bytes <= maxBytes) {
      const length = Math.min(buffer.length, maxBytes + 1 - bytes);
      const count = fs.readSync(fd, buffer, 0, length, null);
      if (count === 0) {
        parts.push(decoder.end());
        return parts.join('');
      }
      bytes += count;
      if (bytes > maxBytes) throw new RangeError('File exceeds byte limit');
      parts.push(decoder.write(buffer.subarray(0, count)));
    }
    throw new RangeError('File exceeds byte limit');
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      fs.closeSync(fd);
    } catch (error) {
      // Preserve a read/open errno so callers can still apply their lock retry policy.
      if (!failed) throw error;
    }
  }
}
