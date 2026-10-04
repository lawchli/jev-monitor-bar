import type {Snapshot} from '../../ipc';

/** Empty copy only describes recorded data; it never stands in for a run. */
export function emptyRunCopy(snapshot?: Snapshot) {
  return snapshot
    ? {title: '还没有运行记录', hint: '任务发来事件后，会显示在这里。'}
    : {title: '正在读取本地记录…', hint: '稍等一下，正在查看已有记录。'};
}
