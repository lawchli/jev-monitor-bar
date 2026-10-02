const sensitive =
  /authorization|cookie|password|passwd|passphrase|secret|token|api.?key|access.?key|private.?key|credential|environment|^env$|raw.?input|prompt|^state$/i;
// Keys of these payload fields are caller-defined candidate/legend names that must stay linked across fields.
const dictionaries = new Set(['candidates', 'probabilities', 'legend', 'usage']);
// Protocol text limit (protocol.ts `str`). Ajv counts code points, so this does too.
const MAX_TEXT = 4096;
function codePoints(text: string) {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

// Free-text `key=value` / `key: value`, as written in logs, JSON, Python reprs and env dumps. The key may be part of a
// longer name (AWS_SECRET_ACCESS_KEY, client_secret, x-api-key); a plural such as max_tokens is not a key. The name's
// tail is bounded so a long `token_a-token_a…` is not rescanned from every part.
const secretKey = String.raw`(?<![A-Za-z0-9])(?:api[_-]?key|access[_-]?key|private[_-]?key|password|passwd|passphrase|secret|token|authorization|credentials?)(?:[_.-][A-Za-z0-9]+){0,6}`;
// A quoted value is replaced whole, spaces included; JSON that was encoded twice quotes with \".
const quoted = String.raw`\\"(?:[^"\\]|\\[^"])*\\"|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'`;
const separator = String.raw`\\?["']?[ \t]*[=:][ \t]*`;
const scheme = String.raw`(?:bearer|basic|digest|token)[ \t]+`;
// Stored events are redacted again on restart and export, so text that is already redacted is left as it is.
const done = String.raw`\\?["']?\[REDACTED\]`;
const keyValue = new RegExp(
  String.raw`(${secretKey}${separator})(?!(?:${scheme})?${done})(${scheme})?(${quoted}|["']?[^\s,;"'&)\]}<>]+)`,
  'gi',
);
// A cookie header holds several `name=value;` pairs, so everything up to the end of the line goes.
const cookie = new RegExp(
  String.raw`(?<![A-Za-z0-9])((?:set-)?cookie${separator})(?!${done})(${quoted}|[^\s"'][^\r\n"']*)`,
  'gi',
);
const hidden = (value: string) => {
  const quote = /^\\?["']/.exec(value)?.[0] ?? '';
  return `${quote}[REDACTED]${quote}`;
};
// Credentials that are recognisable without a key: GitHub, GitLab, Slack, AWS key ids, Google, npm, Hugging Face.
const knownTokens =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,}|npm_[A-Za-z0-9]{30,}|hf_[A-Za-z0-9]{30,})\b/g;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[TRUNCATED]';
  if (typeof value === 'string') {
    let out = value
      // A key cut off by the length limit has no END line; the rest of the text goes with it.
      .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[REDACTED]');
    // Both delimiters are necessary for a match. Avoid scanning ordinary summaries with the URL regex.
    // Keep the bounded scheme and the same replacement/order for strings that could contain userinfo.
    if (out.includes('://') && out.includes('@'))
      out = out.replace(/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/?#@]+@/gi, '$1[REDACTED]@');
    out = out
      .replace(cookie, (_, key: string, v: string) => key + hidden(v))
      .replace(keyValue, (_, key: string, auth: string | undefined, v: string) => key + (auth ?? '') + hidden(v))
      .replace(/Bearer\s+[\w.+\-/=]+/gi, 'Bearer [REDACTED]')
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[REDACTED]')
      .replace(knownTokens, '[REDACTED]')
      .replace(/\b(?:sk|ts|key)[-_][A-Za-z0-9_-]{12,}\b/g, '[REDACTED]');
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
