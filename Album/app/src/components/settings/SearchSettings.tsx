import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ServiceState } from '../../api/health';
import { updateSettings, type SearchMode, type Settings } from '../../api/settings';
import { Icon } from '../common/Icon';
import { FormError } from '../common/states';
import { SettingsCard, StatusPill } from './SettingsCard';

const MODES: { value: SearchMode; label: string }[] = [
  { value: 'words', label: 'Words' },
  { value: 'meaning', label: 'Meaning' },
  { value: 'both', label: 'Both' },
];

/** Default search mode, and the local model behind Meaning search. */
export function SearchSettings({ settings, embedding }: { settings: Settings; embedding: ServiceState | undefined }) {
  const qc = useQueryClient();
  const save = useMutation({ mutationFn: (m: SearchMode) => updateSettings({ defaultSearchMode: m }), onSuccess: (s) => qc.setQueryData(['settings'], s) });
  const status =
    embedding === 'ok' ? (
      <StatusPill tone="ok">Model running</StatusPill>
    ) : embedding === 'disabled' ? (
      <StatusPill tone="off">Model off</StatusPill>
    ) : (
      <StatusPill tone="warn">Model not running</StatusPill>
    );
  return (
    <SettingsCard id="search-heading" icon="search" title="Search" status={status}>
      <fieldset className="mode-field">
        <legend>Default mode</legend>
        <div className="segmented">
          {MODES.map((m) => (
            <label key={m.value} className={settings.defaultSearchMode === m.value ? 'is-active' : ''}>
              <input type="radio" name="default-mode" checked={settings.defaultSearchMode === m.value} disabled={save.isPending} onChange={() => save.mutate(m.value)} />
              <span>{m.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <FormError error={save.error} />
      <dl className="info-list">
        <div>
          <dt>Model</dt>
          <dd>Qwen3-VL-Embedding-2B</dd>
        </div>
        <div>
          <dt>Vectors</dt>
          <dd>2048 dimensions</dd>
        </div>
        <div>
          <dt>Runs on</dt>
          <dd>Local GPU, via vLLM</dd>
        </div>
      </dl>
    </SettingsCard>
  );
}

/** Plain summary of where data goes, next to the switches that control it. */
export function PrivacySummary({ settings }: { settings: Settings }) {
  return (
    <SettingsCard id="privacy-heading" icon="shield" title="Where Your Data Goes">
      <ul className="privacy-list">
        <li>
          <Icon name="checkCircle" size={18} className="ok" />
          <span>
            <strong>This computer</strong> keeps photos, the database and the search index.
          </span>
        </li>
        <li>
          <Icon name="cloud" size={18} />
          <span>
            <strong>DeepSeek</strong> {settings.captionsEnabled ? 'sees each photo once.' : 'gets nothing.'}{' '}
            {settings.openai.fallbackEnabled ? 'OpenAI only as a fallback.' : 'OpenAI is not used.'}
          </span>
        </li>
        <li>
          <Icon name="workflow" size={18} />
          <span>
            <strong>n8n</strong> {settings.n8n.webhookUrl ? 'gets text and tags, never photos.' : 'is not connected.'}
          </span>
        </li>
        <li>
          <Icon name="shield" size={18} />
          <span>No account, no analytics.</span>
        </li>
      </ul>
    </SettingsCard>
  );
}
