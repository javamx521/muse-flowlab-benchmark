import { useEffect, useMemo, useRef, useState } from 'react';

export interface PaletteCommand {
  id: string;
  title: string;
  hint?: string;
  shortcut?: string;
  run: () => void;
}

interface Props {
  open: boolean;
  commands: PaletteCommand[];
  onClose: () => void;
}

/** 简单模糊匹配：query 字符按序出现在 title 中 */
function fuzzyMatch(query: string, title: string): boolean {
  const q = query.toLowerCase().trim();
  if (!q) return true;
  const t = title.toLowerCase();
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

/**
 * 命令面板（Ctrl+K）：模糊搜索并执行编辑器命令。
 * 无障碍：role=dialog + aria-modal，上下键导航，回车执行，Esc 关闭。
 */
export default function CommandPalette({ open, commands, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(
    () => commands.filter((c) => fuzzyMatch(query, c.title)),
    [commands, query],
  );

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      // 下一帧聚焦输入框
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open ]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    // 活动项滚动到可见
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = filtered[active];
      if (cmd) {
        onClose();
        cmd.run();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="cmd-palette-overlay"
      data-testid="palette-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="cmd-palette"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        data-testid="command-palette"
      >
        <input
          ref={inputRef}
          data-testid="palette-input"
          className="cmd-palette-input"
          placeholder="输入命令名称…（↑↓ 选择，回车执行，Esc 关闭）"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="搜索命令"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={filtered[active] ? `palette-item-${filtered[active].id}` : undefined}
        />
        <div
          ref={listRef}
          id="palette-list"
          role="listbox"
          aria-label="命令列表"
          className="cmd-palette-list"
          data-testid="palette-list"
        >
          {filtered.length === 0 && (
            <div className="cmd-palette-empty muted">无匹配命令</div>
          )}
          {filtered.map((c, i) => (
            <div
              key={c.id}
              id={`palette-item-${c.id}`}
              data-idx={i}
              role="option"
              aria-selected={i === active}
              data-testid={`palette-item-${c.id}`}
              className={`cmd-palette-item ${i === active ? 'active' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onClose();
                c.run();
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span>{c.title}</span>
              {c.shortcut && <kbd className="cmd-palette-kbd">{c.shortcut}</kbd>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
