import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { testN8n, updateSettings, type N8nTestResult, type Settings, type SettingsUpdate } from '../../api/settings';
import { FormError } from '../common/states';
import { SecretField } from './SecretField';

/** Connection to the self-hosted n8n "Album enrichment" workflow. */
export function N8nSettings({ settings }: { settings: Settings }) {
  const qc = useQueryClient();
  const [url, setUrl] = useState(settings.n8n.webhookUrl ?? '');
  const [secret, setSecret] = useState<string | undefined>(undefined);
  const [concurrency, setConcurrency] = useState(settings.enrichmentConcurrency);
  const [saved, setSaved] = useState(false);
  const [result, setResult] = useState<N8nTestResult | null>(null);

  const save = useMutation({
    mutationFn: (u: SettingsUpdate) => updateSettings(u),
    onSuccess: (s) => {
      qc.setQueryData(['settings'], s);
      void qc.invalidateQueries({ queryKey: ['processing'] });
      setSecret(undefined);
      setSaved(true);
    },
  });
  const test = useMutation({ mutationFn: testN8n, onSuccess: setResult, onError: (e) => setResult({ ok: false, message: (e as Error).message }) });

  return (
    <form
      className="card settings-form"
      aria-labelledby="n8n-heading"
      onSubmit={(e) => {
        e.preventDefault();
        setResult(null);
        save.mutate({ n8n: { webhookUrl: url.trim() || null, ...(secret !== undefined ? { secret } : {}) }, enrichmentConcurrency: concurrency });
      }}
    >
      <h2 id="n8n-heading">n8n enrichment</h2>
      <p className="privacy-note">
        After a description is written, Album sends its <strong>text and tags</strong> (never the photo) to the “Album enrichment” workflow on your
        n8n server. The workflow tidies them, adds broad categories, saves a row in an n8n Data Table, reads it back, and returns it. Album's own
        library stays the source of truth; if n8n is unavailable, descriptions and search keep working and enrichment catches up later.
      </p>
      <label className="field">
        <span>Webhook URL</span>
        <input
          value={url}
          onChange={(e) => (setSaved(false), setUrl(e.target.value))}
          placeholder="http://localhost:5678/webhook/album-enrichment"
          spellCheck={false}
        />
      </label>
      <SecretField
        label="Webhook secret (X-Album-Secret header)"
        state={settings.n8n.secret}
        value={secret}
        onChange={(v) => (setSaved(false), setSecret(v))}
        onRemove={() => save.mutate({ n8n: { secret: null } })}
        busy={save.isPending}
      />
      <p className="muted small">
        <code>node automation/n8n/deploy.mjs</code> creates the workflow, its Data Table and secret, and fills in both fields.
      </p>
      <label className="field field-narrow">
        <span>Requests at the same time</span>
        <input type="number" min={1} max={64} value={concurrency} onChange={(e) => (setSaved(false), setConcurrency(Math.min(64, Math.max(1, Number(e.target.value) || 1))))} />
      </label>
      <div className="test-row">
        <button type="button" className="btn btn-small" disabled={!settings.n8n.webhookUrl || !settings.n8n.secret.saved || test.isPending} onClick={() => test.mutate()}>
          {test.isPending ? 'Testing…' : 'Test connection'}
        </button>
        {result && (
          <p className={result.ok ? 'test-ok' : 'form-error'} role="status">
            {result.ok
              ? `Works: wrote and read back Data Table row ${result.rowId} (categories: ${result.categories.join(', ') || 'none'}), then removed it.`
              : result.message}
          </p>
        )}
        <p className="muted small">Sends one sample sentence, not your descriptions.</p>
      </div>
      <FormError error={save.error} />
      <div className="dialog-actions">
        {saved && !save.isPending && (
          <span className="test-ok" role="status">
            Saved
          </span>
        )}
        <button type="submit" className="btn btn-primary" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
