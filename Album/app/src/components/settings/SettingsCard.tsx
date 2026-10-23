import type { ReactNode } from 'react';
import { Icon, type IconName } from '../common/Icon';

export function SettingsCard({ icon, title, subtitle, status, children, id }: { icon: IconName; title: string; subtitle?: string; status?: ReactNode; children: ReactNode; id: string }) {
  return (
    <section className="card settings-card" aria-labelledby={id}>
      <header className="card-head">
        <span className="card-icon">
          <Icon name={icon} size={22} />
        </span>
        <div>
          <h2 id={id}>{title}</h2>
          {subtitle && <p className="muted">{subtitle}</p>}
        </div>
        {status && <div className="card-status">{status}</div>}
      </header>
      <div className="card-body">{children}</div>
    </section>
  );
}

/** Label and hint on the left, control on the right, like the concept's settings rows. */
export function FormRow({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="form-row">
      <div className="form-row-label">
        <label htmlFor={htmlFor}>{label}</label>
        {hint && <p className="muted small">{hint}</p>}
      </div>
      <div className="form-row-control">{children}</div>
    </div>
  );
}

export function StatusPill({ tone, children }: { tone: 'ok' | 'warn' | 'off' | 'busy'; children: ReactNode }) {
  return <span className={`status-pill status-${tone}`}>{children}</span>;
}
