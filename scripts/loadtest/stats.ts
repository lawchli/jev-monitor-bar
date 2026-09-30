export interface Summary {
  count: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/** 最近秩法（nearest-rank）百分位。 */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function summarize(values: readonly number[]): Summary {
  if (values.length === 0) return {count: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0};
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    mean: round(sum / sorted.length),
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted[sorted.length - 1]),
  };
}

/** 最小二乘斜率（y 对 x）。点数不足两个时为 0。 */
export function slope(points: readonly {x: number; y: number}[]): number {
  if (points.length < 2) return 0;
  const n = points.length;
  const mx = points.reduce((a, p) => a + p.x, 0) / n;
  const my = points.reduce((a, p) => a + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

export function parseDuration(text: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text.trim());
  if (!match) throw new Error(`无法解析时长：${text}`);
  const value = Number(match[1]);
  const unit = match[2] ?? 's';
  return Math.round(value * {ms: 1, s: 1000, m: 60_000, h: 3_600_000}[unit]!);
}
