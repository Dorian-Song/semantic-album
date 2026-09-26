import type { ReactNode } from 'react';
import { errorMessage } from '../../api/client';
import { Icon, type IconName } from './Icon';

export function EmptyState({ title, icon = 'image', children }: { title: string; icon?: IconName; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name={icon} size={28} />
      </span>
      <p className="empty-title">{title}</p>
      {children}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="error-state" role="alert">
      <Icon name="alert" size={22} />
      <p>{errorMessage(error)}</p>
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <p className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </p>
  );
}

export function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="form-error" role="alert">
      {errorMessage(error)}
    </p>
  );
}

/** Soft blue (or amber) box for explanations inside forms and dialogs. */
export function Callout({ children, tone = 'info', title }: { children: ReactNode; tone?: 'info' | 'warn' | 'ok'; title?: string }) {
  return (
    <div className={`callout callout-${tone}`}>
      <Icon name={tone === 'ok' ? 'checkCircle' : tone === 'warn' ? 'alert' : 'info'} size={20} />
      <div>
        {title && <p className="callout-title">{title}</p>}
        {children}
      </div>
    </div>
  );
}
