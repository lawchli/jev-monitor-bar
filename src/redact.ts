const sensitive =
  /authorization|cookie|password|secret|token|api.?key|credential|environment|^env$|raw.?input|prompt|^state$/i;
// Keys of these payload fields are caller-defined candidate/legend names that must stay linked across fields.
const dictionaries = new Set(['candidates', 'probabilities', 'legend', 'usage']);
// Protocol text limit (protocol.ts `str`). Ajv counts code points, so this does too.
const MAX_TEXT = 4096;
// Quoted values may contain escaped quotes (JSON or Python repr); redact the whole value,
// not just its first word. Header schemes remain useful context after their credentials are removed.
const assignments =
  /(\b(?:[a-z][a-z0-9]*[_-])*(api[_-]?key|password|secret|token|authorization|cookie|aws_secret_access_key)\b["']?[ \t]*[=:][ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|(?:Basic|Bearer)[ \t]+(?:\[REDACTED\]|[\w.+\-/=]+)|\[REDACTED\]|[^\s,;"'{}]+)/gi;
function redactText(text: string) {
  return (
    text
      // Also hide an unfinished block, as summaries may contain only part of a private key.
      .replace(/-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g, '[REDACTED]')
      .replace(/(^[ \t]*(?:set-cookie|cookie)[ \t]*:[ \t]*)[^\r\n]+/gim, '$1[REDACTED]')
      .replace(assignments, (_match, prefix: string, key: string, raw: string) => {
        const quote = raw[0] === '"' || raw[0] === "'" ? raw[0] : '';
        const content = quote ? raw.slice(1, -1) : raw;
        const scheme = /^authorization$/i.test(key) ? /^(Basic|Bearer)[ \t]+/i.exec(content)?.[1] : undefined;
        return `${prefix}${quote}${scheme ? `${scheme} ` : ''}[REDACTED]${quote}`;
      })
      .replace(/(\bBearer[ \t]+)(?:\[REDACTED\]|[\w.+\-/=]+)/gi, '$1[REDACTED]')
      // Userinfo ends at @ before the host; @ in a URL path or query is ordinary text.
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#@"'<>]+@/gi, '$1[REDACTED]@')
      .replace(/\b(?:sk|ts|key)[-_][A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
      .replace(/\b(?:ghp_[A-Za-z0-9]{12,}|xoxb-[A-Za-z0-9-]{12,}|AKIA[A-Z0-9]{16})(?![A-Za-z0-9_-])/g, '[REDACTED]')
      // JWT headers commonly begin with base64url-encoded {" (eyJ). Require three parts
      // so ordinary dotted names and version numbers do not get mistaken for credentials.
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/g, '[REDACTED]')
  );
}
function codePoints(text: string) {
  let count = 0;
  for (const _ of text) count++;
  return count;
}
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[TRUNCATED]';
  if (typeof value === 'string') {
    const out = redactText(value);
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
