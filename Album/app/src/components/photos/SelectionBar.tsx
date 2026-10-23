import type { ReactNode } from 'react';

export function SelectionBar({ count, onClear, onSelectAll, children }: { count: number; onClear: () => void; onSelectAll: () => void; children: ReactNode }) {
  if (count === 0) return null;
  return (
    <div className="selection-bar" role="toolbar" aria-label="Selected photos">
      <strong>{count} selected</strong>
      <button type="button" className="link-btn" onClick={onSelectAll}>
        Select all loaded
      </button>
      <button type="button" className="link-btn" onClick={onClear}>
        Clear
      </button>
      <span className="spacer" />
      {children}
    </div>
  );
}
