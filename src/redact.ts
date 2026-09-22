const sensitive = /authorization|cookie|password|secret|token|api.?key|credential|environment|^env$|raw.?input|prompt|^state$/i;
// Keys of these payload fields are caller-defined candidate/legend names that must stay linked across fields.
const dictionaries = new Set(['candidates','probabilities','legend','usage']);
export function redact(value:unknown, depth=0): unknown {
  if(depth>12) return '[TRUNCATED]';
  if(typeof value==='string') return value
    .replace(/Bearer\s+[\w.+\-/=]+/gi,'Bearer [REDACTED]')
    .replace(/\b(?:sk|ts|key)[-_][A-Za-z0-9_-]{12,}\b/g,'[REDACTED]')
    .replace(/((?:api[_-]?key|password|secret|token|authorization)\s*[=:]\s*)[^\s,;"}]+/gi,'$1[REDACTED]');
  if(Array.isArray(value)) return value.slice(0,255).map(v=>redact(v,depth+1));
  if(value && typeof value==='object') return Object.fromEntries(Object.entries(value).filter(([k])=>!['__proto__','constructor','prototype'].includes(k)).map(([k,v])=>[k,sensitive.test(k)?'[REDACTED]':redact(v,depth+1)]));
  return value;
}
export function sanitizeEvent<T>(event:T,diagnostics=false):T {
  // Keep protocol identity intact; only summaries/diagnostics carry arbitrary text.
  const e=structuredClone(event) as any;
  if(e.payload){if(!diagnostics) delete e.payload.diagnostic;
    e.payload=Object.fromEntries(Object.entries(e.payload).map(([k,v])=>[k,dictionaries.has(k)&&v&&typeof v==='object'
      ?Object.fromEntries(Object.entries(v).map(([name,item])=>[name,redact(item,2)])):redact(v,1)]));
  }
  return e;
}
