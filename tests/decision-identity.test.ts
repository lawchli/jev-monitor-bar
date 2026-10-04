import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {validateEvent, type MonitorEvent, type StoredEvent} from '../src/protocol';
import {applyEvent, emptyRun} from '../src/state';
import {DecisionsTab} from '../src/renderer/expanded/DecisionsTab';
import {decisionCards, type DecisionCardModel} from '../src/renderer/expanded/model';

type ActGlobal = typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?: boolean};

function cardsFor(runId: string, items: Partial<MonitorEvent>[]): DecisionCardModel[] {
  const run = emptyRun(runId);
  for (const [index, item] of items.entries()) {
    const wire = {
      schema_version: 1,
      event_id: `event-${index}`,
      run_id: runId,
      producer_id: 'producer',
      sequence: index,
      occurred_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      type: 'heartbeat',
      payload: {},
      ...item,
    };
    validateEvent(wire);
    const event: StoredEvent = {...wire, received_at: wire.occurred_at, cursor: index + 1};
    applyEvent(run, event);
  }
  return decisionCards(run);
}

function decision(id: string, question: string): Partial<MonitorEvent> {
  return {
    type: 'decision.started',
    decision_id: id,
    request_id: 'request',
    question_id: id,
    payload: {kind: 'choice', question, summary: question},
  };
}

async function withView(
  check: (view: {
    render(cards: DecisionCardModel[]): Promise<void>;
    articles(): HTMLElement[];
    toggle(index: number): Promise<void>;
  }) => Promise<void>,
) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  const globals = globalThis as ActGlobal;
  const previous = {
    window: globals.window,
    document: globals.document,
    HTMLElement: globals.HTMLElement,
    Node: globals.Node,
    IS_REACT_ACT_ENVIRONMENT: globals.IS_REACT_ACT_ENVIRONMENT,
  };
  globals.window = dom.window as unknown as ActGlobal['window'];
  globals.document = dom.window.document;
  globals.HTMLElement = dom.window.HTMLElement;
  globals.Node = dom.window.Node;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const container = dom.window.document.getElementById('root');
  assert.ok(container);
  const root = createRoot(container);
  const warnings: string[] = [];
  const previousError = console.error;
  console.error = (...values: unknown[]) => warnings.push(values.map(String).join(' '));
  const articles = () => Array.from(container.querySelectorAll<HTMLElement>('[data-testid="decision-card"]'));
  try {
    await check({
      render: async cards => {
        await act(async () => root.render(createElement(DecisionsTab, {cards})));
      },
      articles,
      toggle: async index => {
        const button = articles()[index]?.querySelector('button');
        assert.ok(button);
        await act(async () => button.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true})));
      },
    });
    assert.deepEqual(warnings, [], 'valid card identities must not cause React key or aria warnings');
  } finally {
    await act(async () => root.unmount());
    console.error = previousError;
    Object.assign(globals, previous);
    dom.window.close();
  }
}

const expanded = (articles: HTMLElement[]) => articles.map(article => Boolean(article.querySelector('.decision-body')));

test('decision and rule cards retain independent identities for valid delimiter collisions', async () => {
  const cards = cardsFor('run', [
    decision('rule:a:b:c', 'model question'),
    {
      type: 'action.selected',
      action_id: 'a:b',
      attempt_id: 'c',
      payload: {action: 'rule one', source: 'rule'},
    },
    {
      type: 'action.selected',
      action_id: 'a',
      attempt_id: 'b:c',
      payload: {action: 'rule two', source: 'rule'},
    },
  ]);
  assert.deepEqual(
    cards.map(card => card.id),
    ['rule:a:b:c', 'rule:a:b:c', 'rule:a:b:c'],
  );
  assert.equal(new Set(cards.map(card => card.key)).size, 3);

  await withView(async view => {
    await view.render(cards);
    assert.deepEqual(expanded(view.articles()), [true, false, false]);
    await view.toggle(1);
    assert.deepEqual(expanded(view.articles()), [true, true, false]);
    await view.toggle(2);
    assert.deepEqual(expanded(view.articles()), [true, true, true]);
    await view.toggle(1);
    assert.deepEqual(expanded(view.articles()), [true, false, true]);
    assert.match(view.articles()[0].textContent ?? '', /rule two/);
    assert.match(view.articles()[2].textContent ?? '', /model question/);
    await view.render([...cards].reverse());
    assert.deepEqual(expanded(view.articles()), [true, false, false]);
    assert.match(view.articles()[0].textContent ?? '', /model question/);
  });
});

test('valid prototype property IDs do not inherit expansion state', async () => {
  const cards = cardsFor('prototype-run', [
    decision('__proto__', 'prototype question'),
    decision('constructor', 'constructor question'),
    decision('toString', 'string question'),
  ]);
  await withView(async view => {
    await view.render(cards);
    assert.deepEqual(expanded(view.articles()), [true, false, false]);
    await view.toggle(2);
    assert.deepEqual(expanded(view.articles()), [true, false, true]);
    await view.toggle(1);
    assert.deepEqual(expanded(view.articles()), [true, true, true]);
    await view.toggle(0);
    assert.deepEqual(expanded(view.articles()), [false, true, true]);
  });
});

test('expansion is isolated when different runs reuse the same decision ID', async () => {
  const first = cardsFor('run-one', [decision('shared', 'first run')]);
  const second = cardsFor('run-two', [decision('shared', 'second run')]);
  assert.equal(first[0].id, second[0].id);
  assert.notEqual(first[0].key, second[0].key);
  await withView(async view => {
    await view.render(first);
    await view.toggle(0);
    assert.deepEqual(expanded(view.articles()), [false]);
    await view.render(second);
    assert.deepEqual(expanded(view.articles()), [true]);
    assert.match(view.articles()[0].textContent ?? '', /second run/);
    await view.render(first);
    assert.deepEqual(expanded(view.articles()), [false]);
    assert.equal(view.articles()[0].querySelector('h3')?.title, 'first run');
  });
});
