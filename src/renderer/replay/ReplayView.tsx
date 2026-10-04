import {useEffect, useMemo, useState} from 'react';
import type {MonitorBridge, ReplayData} from '../../ipc';
import {ReplayTimeline, fileBase, pageReplay} from '../../replay';
import {DecisionsTab} from '../expanded/DecisionsTab';
import {ExecutionTab} from '../expanded/ExecutionTab';
import {TimelineTab} from '../expanded/TimelineTab';
import {attemptGroups, decisionCards, laterAttemptKeys, runSummary} from '../expanded/model';
import {pickDefaultRun, statusText, truncate} from '../view-model/common';

type TabId = 'decisions' | 'execution' | 'timeline';
type Speed = 1 | 10;

const stepMs: Record<Speed, number> = {1: 800, 10: 80};
const timelineTail = 400;

export function ReplayView({replay, now, onExit}: {replay: ReplayData; now: number; onExit(): void}) {
  const [index, setIndex] = useState(replay.events.length);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  const [runId, setRunId] = useState<string | undefined>();
  const [tab, setTab] = useState<TabId>('decisions');
  // 拖动和播放都从最近的检查点接着算，不再每步从第 0 条重算。
  const timeline = useMemo(() => new ReplayTimeline(replay.events), [replay.events]);
  const snapshot = useMemo(() => timeline.snapshot(index, runId), [timeline, index, runId]);
  const run = snapshot.run;
  const summary = run ? runSummary(run, now) : undefined;
  const selectedRunId = run?.id ?? pickDefaultRun(snapshot.runs)?.id ?? '';
  const name = fileBase(replay.file);

  useEffect(() => {
    if (!playing) return;
    if (index >= replay.events.length) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => {
      setIndex(value => Math.min(replay.events.length, value + 1));
    }, stepMs[speed]);
    return () => clearTimeout(timer);
  }, [playing, speed, index, replay.events.length]);

  const pageBridge = useMemo<MonitorBridge>(
    () => ({
      snapshot: async () => snapshot,
      // An empty replay page is the start of the file, not a dropped live memory window.
      page: async query => ({events: pageReplay(replay.events, index, query), truncated: false}),
      status: async () => {
        throw new Error('回放不读取实时状态');
      },
      onChanged: () => () => {},
      setMode: async mode => mode,
      setPinned: async pinned => pinned,
      exportEvents: async () => ({saved: false}),
      openReplay: async () => null,
    }),
    [snapshot, replay.events, index],
  );

  function pauseAt(next: number) {
    setPlaying(false);
    setIndex(Math.max(0, Math.min(replay.events.length, next)));
  }

  function togglePlay() {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (index >= replay.events.length) setIndex(0);
    setPlaying(true);
  }

  return (
    <section className="expanded-root replay-root" data-testid="replay-root">
      <p className="replay-banner" data-testid="replay-banner" title={replay.file}>
        回放：{name}（不影响实时接收）
        {replay.invalidLines > 0 ? ` · 无效行 ${replay.invalidLines}` : ''}
        {replay.truncated
          ? ` · 只保留最近 ${replay.events.length} 条${replay.omitted ? `，已略过更早的 ${replay.omitted} 条` : ''}`
          : ''}
      </p>
      <div className="replay-controls">
        <button type="button" onClick={() => pauseAt(index - 1)}>
          上一条
        </button>
        <button type="button" onClick={() => pauseAt(index + 1)}>
          下一条
        </button>
        <button type="button" data-testid="replay-play" aria-pressed={playing} onClick={togglePlay}>
          {playing ? '暂停' : '播放'}
        </button>
        <button type="button" aria-pressed={speed === 1} onClick={() => setSpeed(1)}>
          1×
        </button>
        <button type="button" aria-pressed={speed === 10} onClick={() => setSpeed(10)}>
          10×
        </button>
        <input
          type="range"
          min={0}
          max={replay.events.length}
          value={index}
          aria-label="回放进度"
          data-testid="replay-slider"
          onChange={event => pauseAt(Number(event.target.value))}
        />
        <span data-testid="replay-position">
          第 {index} / {replay.events.length} 条
        </span>
        <button type="button" data-testid="replay-exit" onClick={onExit}>
          退出回放
        </button>
      </div>
      {snapshot.runs.length > 0 ? (
        <header className="expanded-header">
          <label className="run-picker">
            <span className="sr-only">运行</span>
            <select
              data-testid="replay-run-picker"
              value={selectedRunId}
              onChange={event => {
                setPlaying(false);
                setRunId(event.target.value);
              }}
            >
              {snapshot.runs.map(item => (
                <option key={item.id} value={item.id}>
                  {truncate(item.name, 24)} · {statusText(item.status)}
                </option>
              ))}
            </select>
          </label>
        </header>
      ) : null}
      {!run || !summary ? (
        <p className="expanded-empty">尚未回放到事件</p>
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
          </div>
          <div className="tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'decisions'} onClick={() => setTab('decisions')}>
              决策
            </button>
            <button type="button" role="tab" aria-selected={tab === 'execution'} onClick={() => setTab('execution')}>
              执行
            </button>
            <button type="button" role="tab" aria-selected={tab === 'timeline'} onClick={() => setTab('timeline')}>
              时间线
            </button>
          </div>
          <div className="expanded-panel" role="tabpanel">
            {tab === 'decisions' ? <DecisionsTab cards={decisionCards(run)} /> : null}
            {tab === 'execution' ? <ExecutionTab key={run.id} groups={attemptGroups(run)} /> : null}
            {tab === 'timeline' ? (
              <TimelineTab
                events={snapshot.events.slice(-timelineTail)}
                runId={run.id}
                bridge={pageBridge}
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
