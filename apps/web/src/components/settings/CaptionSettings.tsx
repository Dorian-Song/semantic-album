import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { getOutdatedDescriptions, refreshOutdatedDescriptions } from '../../api/processing';
import { testCaption, updateSettings, type Settings, type SettingsUpdate, type TestResult } from '../../api/settings';
import { FormError } from '../common/states';
import { SecretField } from './SecretField';

function TestButton({ provider, disabled }: { provider: 'deepseek' | 'openai'; disabled: boolean }) {
  const [result, setResult] = useState<TestResult | null>(null);
  const run = useMutation({ mutationFn: () => testCaption(provider), onSuccess: setResult, onError: (e) => setResult({ ok: false, message: (e as Error).message }) });
  return (
    <div className="test-row">
      <button type="button" className="btn btn-small" disabled={disabled || run.isPending} onClick={() => run.mutate()}>
        {run.isPending ? 'Testing…' : 'Test connection'}
      </button>
      {result && (
        <p className={result.ok ? 'test-ok' : 'form-error'} role="status">
          {result.ok ? (
            <>
              Works ({result.model}). Test picture described as: <em>{result.caption}</em>
            </>
          ) : (
            result.message
          )}
        </p>
      )}
      <p className="muted small">Sends one small generated picture, not your photos.</p>
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
    <div className="notice">
      <p>
        {outdated.data} photo{outdated.data === 1 ? ' has' : 's have'} no description or one from an older version of the description prompt. Updating sends
        {outdated.data === 1 ? ' it' : ' them'} to DeepSeek again; your own descriptions are kept.
      </p>
      <button type="button" className="btn btn-small" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
        {refresh.isSuccess ? `Queued ${refresh.data.queued}` : 'Update descriptions'}
      </button>
    </div>
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

  const submit = () => {
    const u: SettingsUpdate = {
      captionsEnabled: draft.captionsEnabled,
      deepseek: { model: draft.dsModel, baseUrl: draft.dsBaseUrl, ...(draft.dsKey !== undefined ? { apiKey: draft.dsKey } : {}) },
      openai: {
        fallbackEnabled: draft.oaEnabled,
        model: draft.oaModel.trim() || null,
        baseUrl: draft.oaBaseUrl,
        ...(draft.oaKey !== undefined ? { apiKey: draft.oaKey } : {}),
      },
      captionConcurrency: draft.concurrency,
    };
    save.mutate(u);
  };

  const dsKeyReady = settings.deepseek.apiKey.saved || draft.dsKey !== undefined;
  const oaIncomplete = draft.oaEnabled && (!(settings.openai.apiKey.saved || draft.oaKey) || !draft.oaModel.trim());

  return (
    <form
      className="card settings-form"
      aria-labelledby="captions-heading"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h2 id="captions-heading">AI descriptions</h2>
      <p className="privacy-note">
        When this is on, Album sends each imported photo to <strong>DeepSeek</strong>'s cloud API to write a short description and search
        tags. If you also turn on the OpenAI fallback, a photo is sent to <strong>OpenAI</strong> only when DeepSeek cannot describe it. Your
        original photos stay on this computer; the providers' own data policies apply to what they receive.
      </p>
      <label className="toggle">
        <input type="checkbox" checked={draft.captionsEnabled} onChange={(e) => set('captionsEnabled', e.target.checked)} />
        Generate descriptions for my photos
      </label>
      {draft.captionsEnabled && !dsKeyReady && <p className="form-hint">Add a DeepSeek API key below to start.</p>}
      <OutdatedDescriptions enabled={settings.captionsEnabled && settings.deepseek.apiKey.saved} />

      <fieldset className="settings-group">
        <legend>DeepSeek (primary)</legend>
        <SecretField
          label="API key"
          state={settings.deepseek.apiKey}
          value={draft.dsKey}
          onChange={(v) => set('dsKey', v)}
          onRemove={() => save.mutate({ deepseek: { apiKey: null } })}
          busy={save.isPending}
        />
        <label className="field">
          <span>Model</span>
          <input value={draft.dsModel} onChange={(e) => set('dsModel', e.target.value)} spellCheck={false} />
        </label>
        <details>
          <summary>Advanced</summary>
          <label className="field">
            <span>Base URL</span>
            <input value={draft.dsBaseUrl} onChange={(e) => set('dsBaseUrl', e.target.value)} spellCheck={false} />
          </label>
        </details>
        <TestButton provider="deepseek" disabled={!settings.deepseek.apiKey.saved} />
      </fieldset>

      <fieldset className="settings-group">
        <legend>OpenAI (fallback)</legend>
        <label className="toggle">
          <input type="checkbox" checked={draft.oaEnabled} onChange={(e) => set('oaEnabled', e.target.checked)} />
          Use OpenAI when DeepSeek cannot describe a photo
        </label>
        {draft.oaEnabled && (
          <>
            <SecretField
              label="API key"
              state={settings.openai.apiKey}
              value={draft.oaKey}
              onChange={(v) => set('oaKey', v)}
              onRemove={() => save.mutate({ openai: { apiKey: null } })}
              busy={save.isPending}
            />
            <label className="field">
              <span>Model</span>
              <input value={draft.oaModel} onChange={(e) => set('oaModel', e.target.value)} placeholder="A vision-capable model name" spellCheck={false} />
            </label>
            <details>
              <summary>Advanced</summary>
              <label className="field">
                <span>Base URL</span>
                <input value={draft.oaBaseUrl} onChange={(e) => set('oaBaseUrl', e.target.value)} spellCheck={false} />
              </label>
            </details>
            {oaIncomplete && <p className="form-hint">The fallback needs both an API key and a model.</p>}
            <TestButton provider="openai" disabled={!settings.openai.apiKey.saved || !settings.openai.model} />
          </>
        )}
      </fieldset>

      <label className="field field-narrow">
        <span>Photos described at the same time</span>
        <input type="number" min={1} max={500} value={draft.concurrency} onChange={(e) => set('concurrency', Math.min(500, Math.max(1, Number(e.target.value) || 1)))} />
      </label>

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
