import type {ViewProps} from '../types';
import {compactModel} from './model';
import './compact.css';

export function CompactView({
  snapshot,
  status,
  now,
  selectedRunId,
  pinned,
  onTogglePinned,
  onSetMode,
  onSelectRun,
}: ViewProps) {
  const model = compactModel(snapshot, status, now, selectedRunId);
  const meta = `${model.phase} · ${model.progress} · ${model.duration}`;
  const eventLine = `${model.eventTime} ${model.eventType}`;
  const notes = model.notes.join('；');

  return (
    <section className="compact compact-root" data-testid="compact-root" data-empty={model.hasRun ? 'false' : 'true'}>
      <p className="compact-row">
        <span data-testid="compact-status" className={`compact-status compact-fixed tone-${model.runTone}`}>
          <span className="compact-dot" aria-hidden="true" />
          {model.runStatus}
        </span>
        <span data-testid="compact-run-name" className="compact-grow" title={model.nameFull}>
          {model.name}
        </span>
        {model.simulated ? <span className="compact-badge compact-fixed">模拟数据</span> : null}
        <span
          data-testid="compact-connection"
          className={`compact-connection tone-${model.connectionTone}`}
          title={model.connectionText}
        >
          {model.connectionText}
        </span>
        <button
          data-testid="compact-pin"
          type="button"
          className={pinned ? 'is-on' : undefined}
          aria-pressed={pinned}
          title={pinned ? '置顶（开）' : '置顶（关）'}
          onClick={onTogglePinned}
        >
          置顶
        </button>
        <button data-testid="compact-expand" type="button" onClick={() => onSetMode('expanded')}>
          展开
        </button>
      </p>
      {model.hasRun ? (
        <p className="compact-row">
          <span className="compact-grow" title={meta}>
            {meta}
          </span>
        </p>
      ) : (
        <p className="compact-row">
          <span className="compact-grow" title={model.waiting}>
            {model.waiting}
          </span>
        </p>
      )}
      <p className="compact-row" hidden={!model.hasRun}>
        <span data-testid="compact-choice" className="compact-grow" title={model.choice}>
          {model.choice}
        </span>
        <span className="compact-sep">→</span>
        <span data-testid="compact-action" className="compact-grow" title={model.actionText}>
          {model.actionText}
        </span>
        <span className="compact-sep">·</span>
        <span
          data-testid="compact-exec-status"
          className={`compact-fixed tone-${model.execTone}`}
          title={model.execStatus}
        >
          {model.execStatus}
        </span>
      </p>
      <p className="compact-row" hidden={!model.hasRun}>
        <span className="compact-grow" title={eventLine}>
          {eventLine}
        </span>
        {model.otherRunning > 0 && model.nextRunId ? (
          <button type="button" className="compact-link" onClick={() => onSelectRun(model.nextRunId!)}>
            另有 {model.otherRunning} 个运行
          </button>
        ) : null}
      </p>
      {model.storageError ? (
        <p className="compact-row tone-danger" title={model.storageError}>
          <span className="compact-grow">{model.storageError}</span>
        </p>
      ) : null}
      {notes ? (
        <p className="compact-row compact-note" title={notes}>
          <span className="compact-grow">提示：{notes}</span>
        </p>
      ) : null}
    </section>
  );
}
