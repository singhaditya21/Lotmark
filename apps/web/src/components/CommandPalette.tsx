import { useState, useMemo, useEffect, useRef } from 'react';
import type { SearchItem } from '../lib/api';

/**
 * Jump straight to a record by its code (⌘K / Ctrl-K).
 *
 * Everything here is cited by code — PRJ-0412, RMP-PARA-0421, CRT-2041 — and
 * this is how you get from the code back to the record without scanning a
 * table. The whole index arrives once (scoped server-side to what the caller
 * may see); the filtering is here, so a keystroke has no network round-trip.
 */

const KIND_TONE: Record<SearchItem['kind'], string> = {
  project: 'ok', lot: 'ok', certificate: 'warn', study: 'grey',
  value: 'warn', capa: 'bad', order: 'grey',
};

export function CommandPalette({
  open, items, onClose, onSelect,
}: {
  open: boolean;
  items: SearchItem[];
  onClose: () => void;
  onSelect: (item: SearchItem) => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // A fresh palette each time it opens.
  useEffect(() => { if (open) { setQuery(''); setActive(0); } }, [open]);

  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!q) return items.slice(0, 40);
    const scored: Array<{ it: SearchItem; score: number }> = [];
    for (const it of items) {
      const code = it.code.toLowerCase();
      const label = it.label.toLowerCase();
      let score = -1;
      if (code === q) score = 0;
      else if (code.startsWith(q)) score = 1;
      else if (code.includes(q)) score = 2;
      else if (label.includes(q)) score = 3;
      else if (it.detail.toLowerCase().includes(q)) score = 4;
      if (score >= 0) scored.push({ it, score });
    }
    scored.sort((a, b) => a.score - b.score || a.it.code.localeCompare(b.it.code));
    return scored.slice(0, 40).map((x) => x.it);
  }, [items, q]);

  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, results]);

  if (!open) return null;

  const choose = (i: number) => { const it = results[i]; if (it) onSelect(it); };

  return (
    <div className="cmdk-scrim" onClick={onClose}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Jump to a record"
           onClick={(e) => e.stopPropagation()}>
        <input
          className="cmdk-input" autoFocus placeholder="Jump to a code — PRJ-0412, CRT-2041, NCR-0231…"
          value={query} aria-label="Search by code"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
            else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
          }}
        />
        <div className="cmdk-list" ref={listRef}>
          {results.length === 0 ? (
            <div className="cmdk-empty">No code matches “{query}”.</div>
          ) : results.map((it, i) => (
            <button key={`${it.kind}:${it.code}:${i}`} className="cmdk-row" data-active={i === active}
                    onMouseEnter={() => setActive(i)} onClick={() => choose(i)}>
              <span className={`chip ${KIND_TONE[it.kind]}`}>{it.kind}</span>
              <b className="mono">{it.code}</b>
              <span className="cmdk-label">{it.label}</span>
              <span className="muted cmdk-detail">{it.detail}</span>
            </button>
          ))}
        </div>
        <div className="cmdk-foot muted">
          <span><span className="kbd">↑</span><span className="kbd">↓</span> to move</span>
          <span><span className="kbd">↵</span> to open</span>
          <span><span className="kbd">esc</span> to close</span>
        </div>
      </div>
    </div>
  );
}
