import { useQuery } from '@tanstack/react-query';
import { fetchHealth } from '../api/health';
import { getSettings } from '../api/settings';
import { ErrorState, Loading } from '../components/common/states';
import { BaserowSettings } from '../components/settings/BaserowSettings';
import { CaptionSettings } from '../components/settings/CaptionSettings';
import { N8nSettings } from '../components/settings/N8nSettings';
import { ImportHistoryCard, ProcessingCard } from '../components/settings/ProcessingCards';
import { PrivacySummary, SearchSettings } from '../components/settings/SearchSettings';

/** Cards sit in rows; cards in one row share its height, so edges line up whatever their content. */
export function SettingsPage() {
  const health = useQuery({ queryKey: ['health'], queryFn: fetchHealth, refetchInterval: 5000 });
  const settings = useQuery({ queryKey: ['settings'], queryFn: getSettings });
  const services = health.data?.services;
  return (
    <>
      <header className="page-title page-title-row">
        <h1 className="display-title">Settings</h1>
        <p className="handwritten" aria-hidden="true">
          Your photos,
          <br />
          your way
        </p>
      </header>
      {settings.isPending && <Loading />}
      {settings.isError && <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />}
      {settings.data && (
        <div className="settings-rows">
          <div className="settings-row cols-2">
            <SearchSettings settings={settings.data} embedding={services?.embedding} />
            <PrivacySummary settings={settings.data} />
          </div>
          <ProcessingCard />
          <CaptionSettings settings={settings.data} />
          <div className="settings-row cols-2">
            <N8nSettings settings={settings.data} service={services?.n8n} />
            <BaserowSettings />
          </div>
          <ImportHistoryCard />
        </div>
      )}
    </>
  );
}
