import {useEffect, useState} from 'react';
import {truncate} from '../view-model/common';
import type {AttemptGroupModel} from './model';

const attemptsPerPage = 20;

export function ExecutionTab({groups}: {groups: AttemptGroupModel[]}) {
  const [page, setPage] = useState(0);
  const count = groups.reduce((total, group) => total + group.rows.length, 0);
  const pages = Math.max(1, Math.ceil(count / attemptsPerPage));
  const currentPage = Math.min(page, pages - 1);
  useEffect(() => {
    if (page !== currentPage) setPage(currentPage);
  }, [page, currentPage]);

  if (groups.length === 0) return <p className="expanded-empty">尚无执行</p>;
  const start = currentPage * attemptsPerPage;
  const end = start + attemptsPerPage;
  let offset = 0;
  const visible = groups.flatMap(group => {
    const groupStart = offset;
    offset += group.rows.length;
    if (offset <= start || groupStart >= end) return [];
    return [{...group, rows: group.rows.slice(Math.max(0, start - groupStart), end - groupStart)}];
  });

  return (
    <div className="execution-list">
      <nav className="execution-tools" aria-label="执行记录分页">
        <button
          type="button"
          data-testid="execution-previous-page"
          disabled={currentPage === 0}
          onClick={() => setPage(currentPage - 1)}
        >
          上一页
        </button>
        <span data-testid="execution-page" role="status">
          第 {currentPage + 1} / {pages} 页 · 保留 {count} 次尝试
        </span>
        <button
          type="button"
          data-testid="execution-next-page"
          disabled={currentPage === pages - 1}
          onClick={() => setPage(currentPage + 1)}
        >
          下一页
        </button>
      </nav>
      {visible.map(group => (
        <section key={group.actionId} className="attempt-group">
          <h3 title={group.action}>
            动作 {truncate(group.action, 36)} <span className="muted">{group.actionId}</span>
          </h3>
          <ul>
            {group.rows.map(row => (
              <li key={row.key} data-testid="attempt-row">
                <p>
                  <span>第 {row.attemptNumber} 次</span>
                  <span className={`tone-${row.tone}`}>{row.statusText}</span>
                  <span title={row.reason}>原因 {truncate(row.reason, 40)}</span>
                </p>
                {row.checks.length > 0 ? (
                  <table className="check-table">
                    <thead>
                      <tr>
                        <th>检查项</th>
                        <th>观测</th>
                        <th>结果</th>
                        <th>证据</th>
                      </tr>
                    </thead>
                    <tbody>
                      {row.checks.map((check, index) => (
                        <tr key={index}>
                          <td title={check.name}>{truncate(check.name, 16)}</td>
                          <td title={check.observed}>{truncate(check.observed, 24)}</td>
                          <td>{check.resultText}</td>
                          <td title={check.evidence}>{truncate(check.evidence, 24)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
