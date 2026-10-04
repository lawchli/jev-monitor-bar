import type {RunSummary} from '../ipc';
import {redact} from '../redact';
import {exportFileName} from '../replay';

/** A label is only a suggestion; export still includes all retained events. */
export function suggestedExportFileName(now: Date, runs: readonly RunSummary[]): string {
  const fallback = exportFileName(now);
  const run = runs.length === 1 ? runs[0] : undefined;
  // An inferred name is an unredacted protocol ID, not a declared run label.
  if (!run?.started_at || run.name === run.id) return fallback;
  const redacted = String(redact(run.name.normalize('NFKC')));
  if (/\[(?:REDACTED|TRUNCATED)\]/i.test(redacted)) return fallback;
  const label = Array.from(redacted.replace(/[^\p{L}\p{N}]+/gu, '-'))
    .slice(0, 32)
    .join('')
    .replace(/^-+|-+$/g, '');
  // Normalization must not turn previously harmless punctuation into a credential pattern.
  if (!label || redact(label) !== label) return fallback;
  return fallback.replace(/\.jsonl$/, `-${label}.jsonl`);
}
