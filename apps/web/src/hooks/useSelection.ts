import { useCallback, useState } from 'react';

export function useSelection() {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback(
    (id: string) =>
      setSelected((s) => {
        const next = new Set(s);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  const clear = useCallback(() => setSelected(new Set()), []);
  const setAll = useCallback((ids: string[]) => setSelected(new Set(ids)), []);
  return { selected, toggle, clear, setAll };
}
