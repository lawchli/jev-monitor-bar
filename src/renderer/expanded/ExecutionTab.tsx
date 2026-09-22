import {truncate} from '../view-model/common';
import type {AttemptGroupModel} from './model';

export function ExecutionTab({groups}: {groups: AttemptGroupModel[]}) {
  if (groups.length === 0) return <p className="expanded-empty">尚无执行</p>;
  return (
    <div className="execution-list">
      {groups.map(group => (
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
                      {row.checks.map(check => (
                        <tr key={`${row.key}:${check.name}`}>
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
