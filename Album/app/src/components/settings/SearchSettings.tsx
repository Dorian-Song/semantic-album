import { useMutation, useQueryClient } from '@tanstack/react-query';
import { updateSettings, type SearchMode, type Settings } from '../../api/settings';
import { Icon } from '../common/Icon';
import { FormError } from '../common/states';
import { SettingsCard } from './SettingsCard';

const MODES: { value: SearchMode; label: string; hint: string }[] = [
  { value: 'words', label: 'Words', hint: 'Descriptions, tags, text in images, and file names. Fastest.' },
  { value: 'meaning', label: 'Meaning', hint: 'Finds photos by what they show, using the local model.' },
  { value: 'both', label: 'Both', hint: 'Combines words and meaning (recommended).' },
];

export function SearchSettings({ settings }: { settings: Settings }) {
  const qc = useQueryClient();
  const save = useMutation({ mutationFn: (m: SearchMode) => updateSettings({ defaultSearchMode: m }), onSuccess: (s) => qc.setQueryData(['settings'], s) });
  return (
    <SettingsCard id="search-heading" icon="search" title="Search Settings" subtitle="Choose how your photos are searched.">
      <fieldset className="radio-cards">
        <legend>Default search mode</legend>
        {MODES.map((m) => (
          <label key={m.value} className={settings.defaultSearchMode === m.value ? 'is-active' : ''}>
            <input type="radio" name="default-mode" checked={settings.defaultSearchMode === m.value} disabled={save.isPending} onChange={() => save.mutate(m.value)} />
            <span>
              <strong>{m.label}</strong>
              <span className="muted small">{m.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <FormError error={save.error} />
    </SettingsCard>
  );
}

/** Plain summary of where data goes, next to the switches that control it. */
export function PrivacySummary({ settings }: { settings: Settings }) {
  return (
    <SettingsCard id="privacy-heading" icon="shield" title="Where Your Data Goes" subtitle="Updated from your current settings.">
      <ul className="privacy-list">
        <li>
          <Icon name="checkCircle" size={18} className="ok" />
          <span>
            <strong>On this computer:</strong> original photos, copies and thumbnails, the library database, and the search index.
          </span>
        </li>
        <li>
          <Icon name="cloud" size={18} />
          <span>
            <strong>DeepSeek</strong> {settings.captionsEnabled ? 'receives each photo to describe it.' : 'receives nothing while descriptions are off.'}{' '}
            {settings.openai.fallbackEnabled ? 'OpenAI receives a photo only when DeepSeek cannot describe it.' : 'OpenAI is not used.'}
          </span>
        </li>
        <li>
          <Icon name="workflow" size={18} />
          <span>
            <strong>n8n</strong> {settings.n8n.webhookUrl ? `(${new URL(settings.n8n.webhookUrl).host}) receives description text and tags, never photos.` : 'is not connected.'}
          </span>
        </li>
        <li>
          <Icon name="shield" size={18} />
          <span>No account, analytics, or cloud photo storage.</span>
        </li>
      </ul>
    </SettingsCard>
  );
}
