import {useId, useRef} from 'react';

export type ViewTab = 'decisions' | 'execution' | 'timeline';

const tabs: {id: ViewTab; label: string}[] = [
  {id: 'decisions', label: '决策'},
  {id: 'execution', label: '执行'},
  {id: 'timeline', label: '时间线'},
];

export function ViewTabs({
  selected,
  onSelect,
  panelId,
}: {
  selected: ViewTab;
  onSelect(tab: ViewTab): void;
  panelId?: string;
}) {
  const id = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  return (
    <div className="tabs" role="tablist" aria-label="运行详情">
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`${id}-${tab.id}`}
          data-testid={`tab-${tab.id}`}
          aria-selected={selected === tab.id}
          aria-controls={panelId}
          tabIndex={selected === tab.id ? 0 : -1}
          ref={node => {
            buttons.current[index] = node;
          }}
          onClick={() => onSelect(tab.id)}
          onKeyDown={event => {
            const next =
              event.key === 'ArrowRight'
                ? (index + 1) % tabs.length
                : event.key === 'ArrowLeft'
                  ? (index + tabs.length - 1) % tabs.length
                  : event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? tabs.length - 1
                      : undefined;
            if (next === undefined) return;
            event.preventDefault();
            onSelect(tabs[next].id);
            buttons.current[next]?.focus();
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
