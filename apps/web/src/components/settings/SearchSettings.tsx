import { useMutation, useQueryClient } from '@tanstack/react-query';
import { updateSettings, type SearchMode, type Settings } from '../../api/settings';
import { FormError } from '../common/states';

const MODES: { value: SearchMode; label: string; hint: string }[] = [
  { value: 'words', label: 'Words', hint: 'Fastest. Matches descriptions, tags, and file names.' },
  { value: 'meaning', label: 'Meaning', hint: 'Finds photos by what they show, using the local model.' },
  { value: 'both', label: 'Both', hint: 'Combines the two rankings.' },
];

export function SearchSettings({ settings }: { settings: Settings }) {
  const qc = useQueryClient();
  const save = useMutation({ mutationFn: (m: SearchMode) => updateSettings({ defaultSearchMode: m }), onSuccess: (s) => qc.setQueryData(['settings'], s) });
  return (
    <section className="card settings-form" aria-labelledby="search-heading">
      <h2 id="search-heading">Search</h2>
      <fieldset className="radio-list">
        <legend>Default search mode</legend>
        {MODES.map((m) => (
          <label key={m.value}>
            <input type="radio" name="default-mode" checked={settings.defaultSearchMode === m.value} disabled={save.isPending} onChange={() => save.mutate(m.value)} />
            <span>
              <strong>{m.label}</strong> <span className="muted">— {m.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <FormError error={save.error} />
    </section>
  );
}

/** Plain summary of where data goes, next to the switches that control it. */
export function PrivacySummary({ settings }: { settings: Settings }) {
  return (
    <section className="card" aria-labelledby="privacy-heading">
      <h2 id="privacy-heading">Where your data goes</h2>
      <ul className="privacy-list">
        <li>
          <strong>Stays on this computer:</strong> your original photos, their copies and thumbnails, the library database, and the search index
          (built by the local embedding model).
        </li>
        <li>
          <strong>DeepSeek</strong> {settings.captionsEnabled ? 'receives each photo' : 'receives nothing while AI descriptions are off'}
          {settings.captionsEnabled && ' to write its description'}.{' '}
          {settings.openai.fallbackEnabled ? 'OpenAI receives a photo only when DeepSeek cannot describe it.' : 'OpenAI is not used.'}
        </li>
        <li>
          <strong>n8n</strong> {settings.n8n.webhookUrl ? `(${new URL(settings.n8n.webhookUrl).host}) receives description text and tags, never photos.` : 'is not connected.'}
        </li>
        <li>No account, analytics, or cloud photo storage is involved.</li>
      </ul>
    </section>
  );
}
