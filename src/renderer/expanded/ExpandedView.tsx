import {useState} from 'react';
import type {ViewProps} from '../types';
import {statusText, truncate} from '../view-model/common';
import {DecisionsTab} from './DecisionsTab';
import {ExecutionTab} from './ExecutionTab';
import {TimelineTab} from './TimelineTab';
import {attemptGroups, decisionCards, laterAttemptKeys, runSummary} from './model';
import './expanded.css';

type TabId = 'decisions' | 'execution' | 'timeline';

export function ExpandedView({
  snapshot,
  status,
  now,
  selectedRunId,
  onSelectRun,
  onSetMode,
  pinned,
  onTogglePinned,
  onExport,
  onOpenReplay,
  bridge,
}: ViewProps) {
  const [tab, setTab] = useState<TabId>('decisions');
  const runs = [...(snapshot?.runs ?? [])].sort((left, right) => {
    const leftTime = Date.parse(left.last_received ?? '') || 0;
    const rightTime = Date.parse(right.last_received ?? '') || 0;
    return rightTime - leftTime;
  });
  const run = snapshot?.run;
  const summary = run ? runSummary(run, now) : undefined;
  const events = (snapshot?.events ?? []).filter(event => !run || event.run_id === run.id);

  return (
    <section className="expanded-root" data-testid="expanded-root">
      <header className="expanded-header">
        {runs.length > 0 ? (
          <label className="run-picker">
            <span className="sr-only">运行</span>
            <select value={run?.id ?? selectedRunId ?? ''} onChange={event => onSelectRun(event.target.value)}>
              {runs.map(item => (
                <option key={item.id} value={item.id}>
                  {truncate(item.name, 24)} · {statusText(item.status)}
                  {item.simulated ? ' · 模拟' : ''}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <strong className="run-name">JEV Monitor</strong>
        )}
        <button type="button" data-testid="export-events" onClick={onExport}>
          导出
        </button>
        <button type="button" data-testid="open-replay" onClick={onOpenReplay}>
          打开回放
        </button>
        <button type="button" onClick={() => onSetMode('compact')}>
          收起
        </button>
        <button type="button" aria-pressed={pinned} onClick={onTogglePinned}>
          置顶
        </button>
      </header>
      {status?.storageError ? <p className="line tone-danger">{status.storageError}</p> : null}
      {!run || !summary ? (
        <div className="expanded-panel">
          {runs.length > 0 ? (
            <p className="expanded-empty">正在读取运行…</p>
          ) : (
            <>
              <p className="expanded-empty">等待宿主连接…</p>
              <p className="muted">接收端 {status?.listening ? '在监听' : '未监听'}</p>
            </>
          )}
        </div>
      ) : (
        <>
          <h1 className="run-name" title={summary.name}>
            {truncate(summary.name, 40)}
            {summary.simulated ? <span className="badge">模拟数据</span> : null}
          </h1>
          <div className="summary-bar">
            <span className={`tone-${summary.tone}`}>状态 {summary.statusText}</span>
            <span>阶段 {summary.phase}</span>
            <span>进度 {summary.progress}</span>
            <span>运行 {summary.duration}</span>
            <span>{summary.retryText}</span>
            <span className="summary-wide">{summary.verificationText}</span>
            <span>{summary.droppedText}</span>
            <span>{summary.anomalyText}</span>
            {summary.limitedText ? <span className="tone-warning">{summary.limitedText}</span> : null}
          </div>
          <div className="tabs" role="tablist">
            <button
              type="button"
              role="tab"
              data-testid="tab-decisions"
              aria-selected={tab === 'decisions'}
              onClick={() => setTab('decisions')}
            >
              决策
            </button>
            <button
              type="button"
              role="tab"
              data-testid="tab-execution"
              aria-selected={tab === 'execution'}
              onClick={() => setTab('execution')}
            >
              执行
            </button>
            <button
              type="button"
              role="tab"
              data-testid="tab-timeline"
              aria-selected={tab === 'timeline'}
              onClick={() => setTab('timeline')}
            >
              时间线
            </button>
          </div>
          <div className="expanded-panel" role="tabpanel">
            {tab === 'decisions' ? <DecisionsTab cards={decisionCards(run)} /> : null}
            {tab === 'execution' ? <ExecutionTab groups={attemptGroups(run)} /> : null}
            {tab === 'timeline' ? (
              <TimelineTab
                events={events}
                runId={run.id}
                bridge={bridge}
                retryKeys={laterAttemptKeys(run)}
                eventCount={run.event_count}
              />
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
