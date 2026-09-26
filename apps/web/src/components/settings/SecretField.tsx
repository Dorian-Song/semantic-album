import { useState } from 'react';
import type { SecretState } from '../../api/settings';

interface Props {
  label: string;
  state: SecretState;
  /** New value typed by the user, or undefined when unchanged. */
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  onRemove: () => void;
  busy?: boolean;
}

/** A saved secret is never shown; the user can replace or remove it. */
export function SecretField({ label, state, value, onChange, onRemove, busy }: Props) {
  const [replacing, setReplacing] = useState(false);
  if (state.saved && !replacing && value === undefined) {
    return (
      <div className="field">
        <span>{label}</span>
        <div className="secret-saved">
          <span>Saved{state.last4 ? ` (ends in ${state.last4})` : ''}</span>
          <button type="button" className="link-btn" onClick={() => setReplacing(true)}>
            Replace
          </button>
          <button type="button" className="link-btn danger-text" disabled={busy} onClick={onRemove}>
            Remove
          </button>
        </div>
      </div>
    );
  }
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder={state.saved ? 'Enter a new key' : 'Paste your API key'}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
      />
    </label>
  );
}
