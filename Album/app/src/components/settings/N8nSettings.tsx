import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ServiceState } from '../../api/health';
import { testN8n, updateSettings, type N8nTestResult, type Settings, type SettingsUpdate } from '../../api/settings';
import { Icon } from '../common/Icon';
import { FormError } from '../common/states';
import { SecretField } from './SecretField';
import { FormRow, SettingsCard, StatusPill } from './SettingsCard';

/** Connection to the self-hosted n8n "Album enrichment" workflow. */
export function N8nSettings({ settings, service }: { settings: Settings; service: ServiceState | undefined }) {
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
  const connected = !!settings.n8n.webhookUrl && settings.n8n.secret.saved;
  const status = !connected ? (
    <StatusPill tone="off">Not connected</StatusPill>
  ) : service === 'ok' ? (
    <StatusPill tone="ok">Connected</StatusPill>
  ) : (
    <StatusPill tone="warn">Not reachable</StatusPill>
  );

  return (
    <SettingsCard id="n8n-heading" icon="workflow" title="n8n Enrichment" status={status}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          setResult(null);
          save.mutate({ n8n: { webhookUrl: url.trim() || null, ...(secret !== undefined ? { secret } : {}) }, enrichmentConcurrency: concurrency });
        }}
      >
        <FormRow label="Webhook URL" htmlFor="n8n-url">
          <input id="n8n-url" value={url} onChange={(e) => (setSaved(false), setUrl(e.target.value))} placeholder="http://localhost:5678/webhook/album-enrichment" spellCheck={false} />
        </FormRow>
        <FormRow label="Secret" htmlFor="n8n-secret">
          <SecretField
            id="n8n-secret"
            state={settings.n8n.secret}
            value={secret}
            onChange={(v) => (setSaved(false), setSecret(v))}
            onRemove={() => save.mutate({ n8n: { secret: null } })}
            busy={save.isPending}
          />
        </FormRow>
        <FormRow label="Requests at a time" htmlFor="n8n-conc">
          <input
            id="n8n-conc"
            className="input-narrow"
            type="number"
            min={1}
            max={64}
            value={concurrency}
            onChange={(e) => (setSaved(false), setConcurrency(Math.min(64, Math.max(1, Number(e.target.value) || 1))))}
          />
        </FormRow>
        <div className="test-row">
          <button type="button" className="btn btn-soft" disabled={!connected || test.isPending} onClick={() => test.mutate()}>
            <Icon name="refresh" size={16} /> {test.isPending ? 'Testing…' : 'Test connection'}
          </button>
          <div role="status">
            {result === null ? null : result.ok ? (
              <p className="test-ok small">
                <Icon name="checkCircle" size={16} /> Row {result.rowId} written, read back, removed.
              </p>
            ) : (
              <p className="form-error small">{result.message}</p>
            )}
          </div>
        </div>
        <FormError error={save.error} />
        <div className="form-actions">
          {saved && !save.isPending && (
            <span className="test-ok small" role="status">
              <Icon name="check" size={16} /> Saved
            </span>
          )}
          <button type="submit" className="btn btn-primary" disabled={save.isPending}>
            <Icon name="check" /> {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </SettingsCard>
  );
}
