import { api } from './client';
import type { KindSummary, TaskKind } from './types';

export const getProcessing = () => api<{ kinds: KindSummary[] }>('/api/processing').then((r) => r.kinds);
export const getOutdatedDescriptions = () => api<{ outdatedDescriptions: number }>('/api/processing').then((r) => r.outdatedDescriptions);
export const refreshOutdatedDescriptions = () => api<{ queued: number }>('/api/processing/caption/refresh-outdated', { method: 'POST' });
export const retryFailed = (kind: TaskKind) => api<{ requeued: number }>(`/api/processing/${kind}/retry-failed`, { method: 'POST' });

export const KIND_LABELS: Record<TaskKind, string> = {
  caption: 'Descriptions',
  embedding: 'Image search index',
  enrichment: 'n8n enrichment',
  text_embedding: 'Description search index',
};

/** Why a kind is not making progress, in words for the UI; null when it is working normally. */
export function waitingReason(k: KindSummary | undefined): string | null {
  if (!k) return null;
  if (!k.registered) return 'not set up yet';
  if (k.pausedReason) return `paused: ${k.pausedReason}`;
  return null;
}
