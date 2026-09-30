const sensitive =
  /authorization|cookie|password|secret|token|api.?key|credential|environment|^env$|raw.?input|prompt|^state$/i;
// Keys of these payload fields are caller-defined candidate/legend names that must stay linked across fields.
const dictionaries = new Set(['candidates', 'probabilities', 'legend', 'usage']);
// Protocol text limit (protocol.ts `str`). Ajv counts code points, so this does too.
const MAX_TEXT = 4096;
function codePoints(text: string) {
  let count = 0;
  for (const _ of text) count++;
  return count;
}
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[TRUNCATED]';
  if (typeof value === 'string') {
    const out = value
      .replace(/Bearer\s+[\w.+\-/=]+/gi, 'Bearer [REDACTED]')
      .replace(/\b(?:sk|ts|key)[-_][A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
      .replace(/((?:api[_-]?key|password|secret|token|authorization)\s*[=:]\s*)[^\s,;"}]+/gi, '$1[REDACTED]');
    // "token=a" becomes "token=[REDACTED]": longer. A stored event must still validate on restart and export,
    // or an acknowledged event would be dropped there, so text that fit the limit is cut back to it.
    if (out.length <= MAX_TEXT || out === value || codePoints(value) > MAX_TEXT) return out;
    return codePoints(out) > MAX_TEXT ? Array.from(out).slice(0, MAX_TEXT).join('') : out;
  }
  if (Array.isArray(value)) return value.slice(0, 255).map(v => redact(v, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !['__proto__', 'constructor', 'prototype'].includes(k))
        .map(([k, v]) => [k, sensitive.test(k) ? '[REDACTED]' : redact(v, depth + 1)]),
    );
  return value;
}
export function sanitizeEvent<T>(event: T, diagnostics = false): T {
  // Keep protocol identity intact; only summaries/diagnostics carry arbitrary text.
  const e = structuredClone(event) as any;
  if (e.payload) {
    if (!diagnostics) delete e.payload.diagnostic;
    e.payload = Object.fromEntries(
      Object.entries(e.payload).map(([k, v]) => [
        k,
        dictionaries.has(k) && v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([name, item]) => [name, redact(item, 2)]))
          : redact(v, 1),
      ]),
    );
  }
  return e;
}
