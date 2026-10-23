import fs from 'node:fs';
import type { SecretName, Secrets } from './env.js';

/**
 * API keys and the n8n webhook secret. They live in .env only: a value changed on the settings page is
 * written back to that file (replacing its line, or appending one), so backing up the database never copies them.
 */
export class SecretStore {
  private readonly values: Secrets;

  constructor(
    initial: Secrets,
    private readonly envFile: string | null,
  ) {
    this.values = { ...initial };
  }

  get(name: SecretName): string | null {
    return this.values[name];
  }

  set(name: SecretName, value: string | null): void {
    this.values[name] = value;
    if (!this.envFile) return;
    let text = '';
    try {
      text = fs.readFileSync(this.envFile, 'utf8');
    } catch {
      // a missing file is created below
    }
    const line = `${name}=${value ?? ''}`;
    const pattern = new RegExp(`^${name}=.*$`, 'm');
    text = pattern.test(text) ? text.replace(pattern, line) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`;
    fs.writeFileSync(this.envFile, text, { mode: 0o600 });
  }
}
