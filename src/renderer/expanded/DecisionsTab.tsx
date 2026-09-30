import {useState} from 'react';
import {truncate} from '../view-model/common';
import type {DecisionCardModel} from './model';

export function DecisionsTab({cards}: {cards: DecisionCardModel[]}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const firstId = cards[0]?.id;
  if (cards.length === 0) return <p className="expanded-empty">尚无决策</p>;
  return (
    <div className="decision-list">
      {cards.map(card => {
        const expanded = open[card.id] ?? card.id === firstId;
        return (
          <article key={card.id} className="decision-card" data-testid="decision-card">
            <header className="decision-head">
              <span className="badge">{card.badge}</span>
              <h3 title={card.question}>{truncate(card.title, 42)}</h3>
              <span className={`tone-${card.tone}`}>{card.statusText}</span>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setOpen(current => ({...current, [card.id]: !expanded}))}
              >
                {expanded ? '收起' : '展开'}
              </button>
            </header>
            <p className="decision-chain" data-testid="decision-chain">
              {card.chain}
            </p>
            {expanded ? <DecisionBody card={card} /> : null}
          </article>
        );
      })}
    </div>
  );
}

function DecisionBody({card}: {card: DecisionCardModel}) {
  return (
    <div className="decision-body">
      {card.title !== card.question ? <p title={card.question}>问题 {truncate(card.question, 80)}</p> : null}
      <p title={card.summary}>输入摘要 {truncate(card.summary, 80)}</p>
      {card.ruleText ? <p>{card.ruleText}</p> : null}
      {card.choice ? (
        <div className="choice-list">
          {card.choice.bars.map(bar => (
            <div key={bar.name} className={bar.selected ? 'choice-row is-selected' : 'choice-row'}>
              <span className="choice-name" title={bar.description ? `${bar.name} ${bar.description}` : bar.name}>
                {truncate(bar.name, 18)}
                {bar.selected ? ' 已选' : ''}
              </span>
              <span className="prob-track" aria-hidden="true">
                <span className="prob-fill" style={{width: `${bar.width}%`}} />
              </span>
              <span className="prob-text">{bar.probabilityText}</span>
            </div>
          ))}
        </div>
      ) : null}
      {card.score ? (
        <div className="score-block">
          <p>分数 {card.score.scoreText}</p>
          <div className="score-scale">
            {card.score.position !== undefined ? (
              <span className="score-marker" style={{left: `${card.score.position * 100}%`}} />
            ) : null}
            <div className="score-ticks">
              {card.score.legend.map(tick => (
                <span key={tick.key} className={tick.active ? 'score-tick is-active' : 'score-tick'}>
                  {tick.key} {tick.label}
                </span>
              ))}
            </div>
          </div>
          {card.score.probabilities ? (
            <p>概率 {card.score.probabilities.map(item => `${item.name} ${item.text}`).join('、')}</p>
          ) : null}
        </div>
      ) : null}
      {card.noul ? <p className="noul-line">{card.noul.yesText}</p> : null}
      {card.confidenceText ? <p>{card.confidenceText}</p> : null}
      {card.kind === 'decision' ? (
        <>
          <p>{card.modelText}</p>
          <p>{card.latencyText}</p>
          <p title={card.explanationText}>{truncate(card.explanationText, 90)}</p>
        </>
      ) : null}
    </div>
  );
}
