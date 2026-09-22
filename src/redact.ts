const sensitive = /authorization|cookie|password|secret|token|api.?key|credential|environment|^env$|raw.?input|prompt|^state$/i;
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
  if(e.payload){if(!diagnostics) delete e.payload.diagnostic; e.payload=redact(e.payload);
    // Usage counts contain no credentials, and input_tokens is a documented numeric metric.
    if((event as any).payload?.usage) e.payload.usage=Object.fromEntries(Object.entries((event as any).payload.usage).filter(([,v])=>typeof v==='number'));
  }
  return e;
}
