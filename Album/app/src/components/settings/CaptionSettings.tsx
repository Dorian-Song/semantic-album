import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { getOutdatedDescriptions, refreshOutdatedDescriptions } from '../../api/processing';
import { testCaption, updateSettings, type Settings, type SettingsUpdate, type TestResult } from '../../api/settings';
import { Icon } from '../common/Icon';
import { Callout, FormError } from '../common/states';
import { SecretField } from './SecretField';
import { FormRow, SettingsCard, StatusPill } from './SettingsCard';

function TestButton({ provider, disabled }: { provider: 'deepseek' | 'openai'; disabled: boolean }) {
  const [result, setResult] = useState<TestResult | null>(null);
  const run = useMutation({ mutationFn: () => testCaption(provider), onSuccess: setResult, onError: (e) => setResult({ ok: false, message: (e as Error).message }) });
  return (
    <div className="test-row">
      <button type="button" className="btn btn-soft" disabled={disabled || run.isPending} onClick={() => run.mutate()}>
        <Icon name="refresh" size={16} /> {run.isPending ? 'Testing…' : 'Test connection'}
      </button>
      <div role="status">
        {result === null ? (
          disabled && <p className="muted small">Save a key first.</p>
        ) : result.ok ? (
          <p className="test-ok small">
            <Icon name="checkCircle" size={16} /> Works ({result.model}): “{result.caption}”
          </p>
        ) : (
          <p className="form-error small">{result.message}</p>
        )}
      </div>
    </div>
  );
}

/** Offers to re-describe photos whose AI description came from an older prompt. */
function OutdatedDescriptions({ enabled }: { enabled: boolean }) {
  const qc = useQueryClient();
  const outdated = useQuery({ queryKey: ['processing', 'outdated'], queryFn: getOutdatedDescriptions, refetchInterval: 10_000 });
  const refresh = useMutation({ mutationFn: refreshOutdatedDescriptions, onSuccess: () => void qc.invalidateQueries({ queryKey: ['processing'] }) });
  if (!enabled || !outdated.data) return null;
  return (
    <Callout title={`${outdated.data.toLocaleString()} photo${outdated.data === 1 ? '' : 's'} with an outdated description`}>
      <button type="button" className="btn btn-soft btn-small" disabled={refresh.isPending || refresh.isSuccess} onClick={() => refresh.mutate()}>
        {refresh.isSuccess ? `Queued ${refresh.data.queued.toLocaleString()}` : 'Update descriptions'}
      </button>
    </Callout>
  );
}

/** AI descriptions: consent toggle, DeepSeek (primary), OpenAI (fallback), and parallelism. */
export function CaptionSettings({ settings }: { settings: Settings }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState({
    captionsEnabled: settings.captionsEnabled,
    dsModel: settings.deepseek.model,
    dsBaseUrl: settings.deepseek.baseUrl,
    dsKey: undefined as string | undefined,
    oaEnabled: settings.openai.fallbackEnabled,
    oaModel: settings.openai.model ?? '',
    oaBaseUrl: settings.openai.baseUrl,
    oaKey: undefined as string | undefined,
    concurrency: settings.captionConcurrency,
  });
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: (u: SettingsUpdate) => updateSettings(u),
    onSuccess: (s) => {
      qc.setQueryData(['settings'], s);
      void qc.invalidateQueries({ queryKey: ['processing'] });
      setDraft((d) => ({ ...d, dsKey: undefined, oaKey: undefined }));
      setSaved(true);
    },
  });
  const set = <K extends keyof typeof draft>(k: K, v: (typeof draft)[K]) => {
    setSaved(false);
    setDraft((d) => ({ ...d, [k]: v }));
  };

  const submit = () =>
    save.mutate({
      captionsEnabled: draft.captionsEnabled,
      deepseek: { model: draft.dsModel, baseUrl: draft.dsBaseUrl, ...(draft.dsKey !== undefined ? { apiKey: draft.dsKey } : {}) },
      openai: {
        fallbackEnabled: draft.oaEnabled,
        model: draft.oaModel.trim() || null,
        baseUrl: draft.oaBaseUrl,
        ...(draft.oaKey !== undefined ? { apiKey: draft.oaKey } : {}),
      },
      captionConcurrency: draft.concurrency,
    });

  const dsKeyReady = settings.deepseek.apiKey.saved || draft.dsKey !== undefined;
  const oaIncomplete = draft.oaEnabled && (!(settings.openai.apiKey.saved || draft.oaKey) || !draft.oaModel.trim());
  const status = !settings.captionsEnabled ? (
    <StatusPill tone="off">Off</StatusPill>
  ) : settings.deepseek.apiKey.saved ? (
    <StatusPill tone="ok">On</StatusPill>
  ) : (
    <StatusPill tone="warn">Needs a key</StatusPill>
  );

  return (
    <SettingsCard id="captions-heading" icon="cloud" title="Photo Descriptions" status={status}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="caption-top">
          <label className="switch">
            <input type="checkbox" role="switch" checked={draft.captionsEnabled} onChange={(e) => set('captionsEnabled', e.target.checked)} />
            <span className="switch-track" aria-hidden="true" />
            Generate descriptions for my photos
          </label>
          <label className="inline-field">
            Photos at a time
            <input className="input-narrow" type="number" min={1} max={1000} value={draft.concurrency} onChange={(e) => set('concurrency', Math.min(1000, Math.max(1, Number(e.target.value) || 1)))} />
          </label>
        </div>
        {draft.captionsEnabled && !dsKeyReady && <p className="form-hint">Add a DeepSeek API key below to start.</p>}
        <OutdatedDescriptions enabled={settings.captionsEnabled && settings.deepseek.apiKey.saved} />

        <div className="provider-cols">
        <fieldset className="settings-group">
          <legend>DeepSeek (primary)</legend>
          <FormRow label="API key" htmlFor="ds-key">
            <SecretField
              id="ds-key"
              state={settings.deepseek.apiKey}
              value={draft.dsKey}
              onChange={(v) => set('dsKey', v)}
              onRemove={() => save.mutate({ deepseek: { apiKey: null } })}
              busy={save.isPending}
            />
          </FormRow>
          <FormRow label="Model" htmlFor="ds-model">
            <input id="ds-model" value={draft.dsModel} onChange={(e) => set('dsModel', e.target.value)} spellCheck={false} />
          </FormRow>
          <FormRow label="Base URL" htmlFor="ds-url">
            <input id="ds-url" value={draft.dsBaseUrl} onChange={(e) => set('dsBaseUrl', e.target.value)} spellCheck={false} />
          </FormRow>
          <TestButton provider="deepseek" disabled={!settings.deepseek.apiKey.saved} />
        </fieldset>

        <fieldset className="settings-group">
          <legend>OpenAI (fallback)</legend>
          <label className="switch">
            <input type="checkbox" role="switch" checked={draft.oaEnabled} onChange={(e) => set('oaEnabled', e.target.checked)} />
            <span className="switch-track" aria-hidden="true" />
            Use when DeepSeek fails
          </label>
          {draft.oaEnabled && (
            <>
              <FormRow label="API key" htmlFor="oa-key">
                <SecretField
                  id="oa-key"
                  state={settings.openai.apiKey}
                  value={draft.oaKey}
                  onChange={(v) => set('oaKey', v)}
                  onRemove={() => save.mutate({ openai: { apiKey: null } })}
                  busy={save.isPending}
                />
              </FormRow>
              <FormRow label="Model" htmlFor="oa-model">
                <input id="oa-model" value={draft.oaModel} onChange={(e) => set('oaModel', e.target.value)} spellCheck={false} />
              </FormRow>
              <FormRow label="Base URL" htmlFor="oa-url">
                <input id="oa-url" value={draft.oaBaseUrl} onChange={(e) => set('oaBaseUrl', e.target.value)} spellCheck={false} />
              </FormRow>
              {oaIncomplete && <p className="form-hint">The fallback needs both an API key and a model.</p>}
              <TestButton provider="openai" disabled={!settings.openai.apiKey.saved || !settings.openai.model} />
            </>
          )}
        </fieldset>
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
