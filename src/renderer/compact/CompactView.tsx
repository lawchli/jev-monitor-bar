import type {ViewProps} from '../types';

export function CompactView({snapshot, status}: ViewProps) {
  const count = snapshot?.runs.length ?? 0;
  const latest = snapshot?.events.at(-1)?.type ?? '无';
  const listening = status?.listening === true;
  return (
    <section className="compact">
      <p className="line">运行数 {count}</p>
      <p className="line">最新事件 {latest}</p>
      <p className="line">监听 {listening ? '是' : '否'}</p>
      {status?.storageError ? <p className="line tone-danger">{status.storageError}</p> : null}
    </section>
  );
}
