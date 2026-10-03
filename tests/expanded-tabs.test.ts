import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act, createElement, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {LiveDetailTabs, type LiveDetailTabId} from '../src/renderer/expanded/LiveDetailTabs';

type ActGlobal = typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?: boolean};

function DetailTabs({revision = 0}: {revision?: number}) {
  const [selected, onSelect] = useState<LiveDetailTabId>('decisions');
  return createElement(LiveDetailTabs, {
    selected,
    onSelect,
    children: tab => createElement('button', {type: 'button', 'aria-label': `${tab} 内容`}, revision),
  });
}

async function withTabs(run: (dom: JSDOM, render: (revision?: number, copies?: number) => void) => Promise<void>) {
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
  const rootElement = dom.window.document.getElementById('root');
  assert.ok(rootElement);
  const root = createRoot(rootElement);
  const render = (revision = 0, copies = 1) => {
    root.render(
      createElement(
        'div',
        null,
        Array.from({length: copies}, (_, index) => createElement(DetailTabs, {key: index, revision})),
      ),
    );
  };
  try {
    await act(async () => render());
    await run(dom, render);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globals, previous);
  }
}

function tabs(dom: JSDOM): HTMLButtonElement[] {
  return Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
}

function assertSelected(dom: JSDOM, index: number, focused = true) {
  const buttons = tabs(dom);
  assert.deepEqual(
    buttons.map(button => button.getAttribute('aria-selected')),
    buttons.map((_, buttonIndex) => String(buttonIndex === index)),
  );
  assert.deepEqual(
    buttons.map(button => button.tabIndex),
    buttons.map((_, buttonIndex) => (buttonIndex === index ? 0 : -1)),
  );
  if (focused) assert.equal(dom.window.document.activeElement, buttons[index]);
  const panels = Array.from(dom.window.document.querySelectorAll<HTMLElement>('[role="tabpanel"]'));
  assert.deepEqual(
    panels.map(panel => panel.hidden),
    panels.map((_, panelIndex) => panelIndex !== index),
  );
  assert.equal(
    panels[index].querySelector('button')?.getAttribute('aria-label'),
    `${buttons[index].dataset.testid?.slice(4)} 内容`,
  );
  assert.equal(dom.window.document.querySelectorAll('[role="tabpanel"] button').length, 1);
}

async function key(dom: JSDOM, value: string, shiftKey = false) {
  const KeyboardEvent = (dom.window as unknown as {KeyboardEvent: typeof globalThis.KeyboardEvent}).KeyboardEvent;
  const event = new KeyboardEvent('keydown', {key: value, shiftKey, bubbles: true, cancelable: true});
  await act(async () => {
    dom.window.document.activeElement?.dispatchEvent(event);
  });
  return event;
}

test('LIVE detail tabs connect panels, expose one tab stop and do not focus on mount', async () => {
  await withTabs(async dom => {
    assertSelected(dom, 0, false);
    assert.equal(dom.window.document.activeElement, dom.window.document.body);
    const tablist = dom.window.document.querySelector('[role="tablist"]');
    assert.equal(tablist?.getAttribute('aria-label'), '运行详情');
    assert.equal(tablist?.getAttribute('aria-orientation'), 'horizontal');
    for (const button of tabs(dom)) {
      const panel = dom.window.document.getElementById(button.getAttribute('aria-controls') ?? '');
      assert.ok(panel);
      assert.equal(panel.getAttribute('role'), 'tabpanel');
      assert.equal(panel.getAttribute('aria-labelledby'), button.id);
      assert.equal(panel.tabIndex, 0);
    }
  });
});

test('Left/Right wrap and Home/End select, focus and display the matching LIVE panel', async () => {
  await withTabs(async dom => {
    tabs(dom)[0].focus();
    for (const [value, index] of [
      ['ArrowLeft', 2],
      ['ArrowRight', 0],
      ['ArrowRight', 1],
      ['ArrowRight', 2],
      ['ArrowRight', 0],
      ['End', 2],
      ['Home', 0],
      ['ArrowRight', 1],
      ['ArrowLeft', 0],
    ] as const) {
      assert.equal((await key(dom, value)).defaultPrevented, true, value);
      assertSelected(dom, index);
    }
  });
});

test('mouse selection shares the tab stop; Tab, Shift+Tab and vertical arrows keep their native behavior', async () => {
  await withTabs(async dom => {
    await act(async () => {
      tabs(dom)[1].dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
    });
    assertSelected(dom, 1);
    for (const value of ['Tab', 'ArrowUp', 'ArrowDown', 'Escape']) {
      assert.equal((await key(dom, value)).defaultPrevented, false, value);
      assertSelected(dom, 1);
    }
    assert.equal((await key(dom, 'Tab', true)).defaultPrevented, false);
    assertSelected(dom, 1);
  });
});

test('a LIVE refresh retains selection and leaves focused panel content alone', async () => {
  await withTabs(async (dom, render) => {
    tabs(dom)[0].focus();
    await key(dom, 'End');
    const contentButton = dom.window.document.querySelector<HTMLButtonElement>('[role="tabpanel"] button');
    assert.ok(contentButton);
    contentButton.focus();
    await act(async () => render(1));
    assertSelected(dom, 2, false);
    assert.equal(dom.window.document.activeElement, contentButton);
    assert.equal(contentButton.textContent, '1');
    assert.equal((await key(dom, 'Home')).defaultPrevented, false);
    assertSelected(dom, 2, false);
  });
});

test('separate LIVE tab groups have unique stable tab and panel IDs', async () => {
  await withTabs(async (dom, render) => {
    await act(async () => render(0, 2));
    const ids = () =>
      Array.from(dom.window.document.querySelectorAll('[role="tab"], [role="tabpanel"]'), node => node.id);
    const before = ids();
    assert.equal(before.length, 12);
    assert.equal(new Set(before).size, before.length);
    await act(async () => render(1, 2));
    assert.deepEqual(ids(), before);
    for (const button of tabs(dom)) {
      assert.equal(
        dom.window.document.getElementById(button.getAttribute('aria-controls') ?? '')?.getAttribute('aria-labelledby'),
        button.id,
      );
    }
  });
});
