import { useEffect, useState } from 'react';
import { fetchHealth, type Health, type ServiceState } from '../api/health';

const NAV = ['Home', 'All Photos', 'Albums', 'Settings'] as const;

const SERVICE_LABELS: Record<keyof Health['services'], string> = {
  database: 'Library database',
  n8n: 'n8n enrichment',
  embedding: 'Local embedding model',
};

const STATE_TEXT: Record<ServiceState, string> = {
  ok: 'Running',
  unreachable: 'Not reachable',
  disabled: 'Disabled',
  not_configured: 'Not configured',
};

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchHealth()
        .then((h) => !cancelled && (setHealth(h), setError(null)))
        .catch(() => !cancelled && setError('The Album backend is not responding.'));
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-name">Album</span>
          <span className="brand-tag">Your photos, your place</span>
        </div>
        <nav aria-label="Main">
          <ul>
            {NAV.map((item) => (
              <li key={item}>
                <a href="#" aria-current={item === 'Home' ? 'page' : undefined}>
                  {item}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <main className="content">
        <h1>Welcome to Album</h1>
        <p className="muted">The app skeleton is running. Albums and imports arrive in the next build step.</p>

        <section className="card" aria-labelledby="status-heading">
          <h2 id="status-heading">System status</h2>
          {error && <p role="alert">{error}</p>}
          {!health && !error && <p className="muted">Checking services…</p>}
          {health && (
            <dl className="status-list">
              {(Object.keys(SERVICE_LABELS) as (keyof Health['services'])[]).map((key) => (
                <div key={key} className="status-row">
                  <dt>{SERVICE_LABELS[key]}</dt>
                  <dd data-state={health.services[key]}>{STATE_TEXT[health.services[key]]}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      </main>
    </div>
  );
}
