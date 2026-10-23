import { OutputTooLongError, RejectedError, ServiceUnavailableError } from '../../data-access/egress/errors.js';
import type { SettingsService } from '../settings/settings.js';
import { deepseek, openai, type LlmImage, type ProviderConfig, type ProviderName } from './providers.js';

export type { LlmImage, ProviderName };

/** The answer could not be used (for example it was not the requested JSON). */
export class InvalidOutputError extends RejectedError {}

export interface LlmRequest<T> {
  instructions: string;
  prompt: string;
  /** A shorter-answer version of the prompt, tried once when an answer is cut off at the output limit. */
  shortPrompt?: string;
  images?: readonly LlmImage[];
  /** The answer's JSON schema, for providers that enforce one. */
  schema: { name: string; schema: object };
  /** Turns the answer text into the result; throws InvalidOutputError when it is unusable. */
  parse(text: string): T;
}

export interface LlmResult<T> {
  value: T;
  provider: ProviderName;
  model: string;
}

/**
 * Large-language-model calls. DeepSeek answers by default; OpenAI is the fallback, used only when DeepSeek
 * cannot handle this request (it rejected it, the answer was unusable or cut off even in short form) or, on the
 * caller's last try, failed for any other reason. A rate limit or a refused account is reported to the caller,
 * never answered by switching providers.
 */
export class Llm {
  constructor(private readonly settings: SettingsService) {}

  async generate<T>(req: LlmRequest<T>, opts: { lastTry?: boolean } = {}): Promise<LlmResult<T>> {
    const s = this.settings.get();
    if (!s.deepseek.apiKey) throw new ServiceUnavailableError('Add a DeepSeek API key in Settings', 60_000);
    const primary: ProviderConfig = { baseUrl: s.deepseek.baseUrl, model: s.deepseek.model, apiKey: s.deepseek.apiKey };

    let failure: unknown;
    try {
      try {
        return await this.ask('deepseek', primary, req, req.prompt);
      } catch (err) {
        if (!(err instanceof OutputTooLongError) || !req.shortPrompt) throw err;
        return await this.ask('deepseek', primary, req, req.shortPrompt);
      }
    } catch (err) {
      failure = err;
    }

    if (failure instanceof ServiceUnavailableError) throw failure;
    const cannotHandle = failure instanceof RejectedError || failure instanceof OutputTooLongError;
    const fb = s.openai;
    if (!(cannotHandle || opts.lastTry) || !fb.fallbackEnabled || !fb.apiKey || !fb.model) {
      throw failure instanceof OutputTooLongError ? new RejectedError(failure.message) : failure;
    }
    try {
      return await this.ask('openai', { baseUrl: fb.baseUrl, model: fb.model, apiKey: fb.apiKey }, req, req.shortPrompt ?? req.prompt);
    } catch (fallbackErr) {
      const why = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      throw new RejectedError(`${(failure as Error).message}; OpenAI fallback also failed: ${why}`);
    }
  }

  /** One provider only, with its saved settings; for connection tests. */
  generateWith<T>(provider: ProviderName, req: LlmRequest<T>): Promise<LlmResult<T>> {
    const s = this.settings.get();
    if (provider === 'deepseek') {
      if (!s.deepseek.apiKey) throw new ServiceUnavailableError('Save a DeepSeek API key first');
      return this.ask('deepseek', { baseUrl: s.deepseek.baseUrl, model: s.deepseek.model, apiKey: s.deepseek.apiKey }, req, req.prompt);
    }
    if (!s.openai.apiKey || !s.openai.model) throw new ServiceUnavailableError('Save an OpenAI API key and model first');
    return this.ask('openai', { baseUrl: s.openai.baseUrl, model: s.openai.model, apiKey: s.openai.apiKey }, req, req.prompt);
  }

  private async ask<T>(provider: ProviderName, cfg: ProviderConfig, req: LlmRequest<T>, prompt: string): Promise<LlmResult<T>> {
    const call = provider === 'deepseek' ? deepseek : openai;
    const answer = await call(cfg, { instructions: req.instructions, prompt, images: req.images ?? [], schema: req.schema });
    return { value: req.parse(answer.text), provider, model: answer.model };
  }
}
