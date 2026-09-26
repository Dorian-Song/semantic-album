import { useQuery } from '@tanstack/react-query';
import { fetchHealth } from '../api/health';
import { getSettings } from '../api/settings';
import { ErrorState, Loading } from '../components/common/states';
import { CaptionSettings } from '../components/settings/CaptionSettings';
import { N8nSettings } from '../components/settings/N8nSettings';
import { EmbeddingCard, ImportHistoryCard, ProcessingCard } from '../components/settings/ProcessingCards';
import { PrivacySummary, SearchSettings } from '../components/settings/SearchSettings';

export function SettingsPage() {
  const health = useQuery({ queryKey: ['health'], queryFn: fetchHealth, refetchInterval: 5000 });
  const settings = useQuery({ queryKey: ['settings'], queryFn: getSettings });
  const services = health.data?.services;
  return (
    <>
      <header className="page-title page-title-row">
        <div>
          <h1 className="display-title">Settings</h1>
          <p className="muted">Customize how Album works on your computer.</p>
        </div>
        <p className="handwritten" aria-hidden="true">
          Your photos,
          <br />
          your way
        </p>
      </header>
      {settings.isPending && <Loading />}
      {settings.isError && <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />}
      {settings.data && (
        <div className="settings-grid">
          <div className="settings-col">
            <SearchSettings settings={settings.data} />
            <ProcessingCard />
            <ImportHistoryCard />
          </div>
          <div className="settings-col">
            <CaptionSettings settings={settings.data} />
            <EmbeddingCard service={services?.embedding} />
            <N8nSettings settings={settings.data} service={services?.n8n} />
            <PrivacySummary settings={settings.data} />
          </div>
        </div>
      )}
    </>
  );
}
