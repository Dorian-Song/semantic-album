import { useEffect, useState } from 'react';
import { Dialog } from '../common/Dialog';
import { Icon } from '../common/Icon';

/**
 * Copies a description to the clipboard. The button confirms with "Copied" for two seconds; if the browser
 * refuses (no clipboard access, e.g. plain http on a LAN address, or permission denied), a dialog says so.
 */
export function CopyDescriptionButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard not available');
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setFailed(true);
    }
  };

  return (
    <>
      <button type="button" className={copied ? 'copy-btn is-done' : 'copy-btn'} onClick={() => void copy()} aria-live="polite">
        <Icon name={copied ? 'check' : 'copy'} size={14} />
        {copied ? 'Copied' : 'Copy'}
      </button>
      {failed && (
        <Dialog title="Couldn’t copy the description" onClose={() => setFailed(false)}>
          <div className="dialog-body">
            <p>The browser did not allow Album to use the clipboard. Select the description and copy it with Ctrl+C instead.</p>
          </div>
          <div className="dialog-actions">
            <button type="button" className="btn btn-primary" onClick={() => setFailed(false)}>
              OK
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
