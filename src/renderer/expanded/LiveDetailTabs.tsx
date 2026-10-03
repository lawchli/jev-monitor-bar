import {useId, useRef, type KeyboardEvent, type ReactNode} from 'react';

const tabs = [
  {id: 'decisions', label: '决策'},
  {id: 'execution', label: '执行'},
  {id: 'timeline', label: '时间线'},
] as const;

export type LiveDetailTabId = (typeof tabs)[number]['id'];

export function LiveDetailTabs({
  selected,
  onSelect,
  children,
}: {
  selected: LiveDetailTabId;
  onSelect: (tab: LiveDetailTabId) => void;
  children: (tab: LiveDetailTabId) => ReactNode;
}) {
  const id = useId();
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  const activate = (index: number) => {
    onSelect(tabs[index].id);
    buttons.current[index]?.focus();
  };

  const navigate = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number;
    switch (event.key) {
      case 'ArrowLeft':
        next = (index + tabs.length - 1) % tabs.length;
        break;
      case 'ArrowRight':
        next = (index + 1) % tabs.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = tabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    activate(next);
  };

  return (
    <>
      <div className="tabs" role="tablist" aria-label="运行详情" aria-orientation="horizontal">
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            ref={button => {
              buttons.current[index] = button;
            }}
            id={`${id}-tab-${tab.id}`}
            type="button"
            role="tab"
            data-testid={`tab-${tab.id}`}
            aria-selected={selected === tab.id}
            aria-controls={`${id}-panel-${tab.id}`}
            tabIndex={selected === tab.id ? 0 : -1}
            onClick={() => activate(index)}
            onKeyDown={event => navigate(event, index)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map(tab => (
        <div
          key={tab.id}
          id={`${id}-panel-${tab.id}`}
          className="expanded-panel"
          role="tabpanel"
          aria-labelledby={`${id}-tab-${tab.id}`}
          hidden={selected !== tab.id}
          tabIndex={0}
        >
          {selected === tab.id ? children(tab.id) : null}
        </div>
      ))}
    </>
  );
}
