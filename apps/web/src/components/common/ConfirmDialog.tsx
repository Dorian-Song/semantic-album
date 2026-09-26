import { useState, type ReactNode } from 'react';
import { Dialog } from './Dialog';
import { FormError } from './states';

interface Props {
  title: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<unknown>;
  onClose: () => void;
  children: ReactNode;
}

export function ConfirmDialog({ title, confirmLabel, danger, onConfirm, onClose, children }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Dialog title={title} onClose={onClose}>
      <form
        method="dialog"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await onConfirm();
            onClose();
          } catch (err) {
            setError(err);
            setBusy(false);
          }
        }}
      >
        <div className="dialog-body">{children}</div>
        <FormError error={error} />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={danger ? 'btn btn-danger' : 'btn btn-primary'} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
