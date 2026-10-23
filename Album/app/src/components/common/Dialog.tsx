import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Wider layout for pickers with lists. */
  wide?: boolean;
}

/**
 * Modal built on the native <dialog>: focus is trapped, Escape closes, and focus returns to the opener.
 * Mount it only while open; it opens itself on mount.
 */
export function Dialog({ title, onClose, children, wide }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);

  return (
    <dialog
      ref={ref}
      className={wide ? 'dialog dialog-wide' : 'dialog'}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header className="dialog-head">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>
      {children}
    </dialog>
  );
}
