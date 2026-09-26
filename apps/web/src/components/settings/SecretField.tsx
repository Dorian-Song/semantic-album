import { useState } from 'react';
import type { SecretState } from '../../api/settings';
import { Icon } from '../common/Icon';

interface Props {
  id: string;
  state: SecretState;
  /** New value typed by the user, or undefined when unchanged. */
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  onRemove: () => void;
  busy?: boolean;
}

/** A saved secret is never shown; the user can replace or remove it. A typed one can be revealed. */
export function SecretField({ id, state, value, onChange, onRemove, busy }: Props) {
  const [replacing, setReplacing] = useState(false);
  const [visible, setVisible] = useState(false);
  if (state.saved && !replacing && value === undefined) {
    return (
      <div className="secret-saved">
        <span className="secret-dots" aria-label={`Saved${state.last4 ? `, ends in ${state.last4}` : ''}`}>
          ••••••••••••{state.last4 ?? ''}
        </span>
        <button type="button" className="link-btn" onClick={() => setReplacing(true)}>
          Replace
        </button>
        <button type="button" className="link-btn danger-text" disabled={busy} onClick={onRemove}>
          Remove
        </button>
      </div>
    );
  }
  return (
    <div className="input-with-button">
      <input
        id={id}
        type={visible ? 'text' : 'password'}
        autoComplete="off"
        spellCheck={false}
        placeholder={state.saved ? 'Enter a new key' : 'Paste your API key'}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
      />
      <button type="button" className="icon-btn" aria-label={visible ? 'Hide key' : 'Show key'} aria-pressed={visible} onClick={() => setVisible((v) => !v)}>
        <Icon name={visible ? 'eyeOff' : 'eye'} size={16} />
      </button>
    </div>
  );
}
