import {Script} from 'node:vm';

// Electron documents ASAR integrity on macOS and Windows, not Linux:
// https://www.electronjs.org/docs/latest/tutorial/asar-integrity
export const supportsAsarIntegrity = platform => platform === 'darwin' || platform === 'win32';

/** Change only an ASCII letter inside an esbuild source comment, preserving valid and equivalent JavaScript. */
export function harmlessMainTamper(source) {
  const text = source.toString('utf8');
  new Script(text, {filename: 'main.cjs'});
  const comment = /^\/\/ [A-Za-z]/m.exec(text);
  if (!comment) throw new Error('No esbuild source comment available for a harmless integrity probe');
  const offset = Buffer.byteLength(text.slice(0, comment.index + 3));
  const before = source[offset];
  const after = before ^ 0x20;
  const changed = Buffer.from(source);
  changed[offset] = after;
  new Script(changed.toString('utf8'), {filename: 'tampered-main.cjs'});
  return {offset, before, after};
}

/** An unrelated crash or syntax error is not evidence that ASAR integrity rejected the archive. */
export function integrityRejected({exited, started, output}) {
  return (
    Boolean(exited) &&
    !started &&
    /ValidateIntegrityOrDie|integrity.*(?:fail|mismatch|invalid)|(?:fail|mismatch|invalid).*integrity/i.test(output)
  );
}
