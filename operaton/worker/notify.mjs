// Review notifications through a Make scenario (webhook -> format -> email -> webhook response).
// Only text about the submission is sent, never the photo. The outcome is written to the submission's
// Notification field; a failed notification is retried on later passes with a growing wait, up to MAX_ATTEMPTS.
import { config } from './config.mjs';

const EVENTS = { 'Waiting for admin': 'waiting_for_admin', Published: 'published', Rejected: 'rejected' };
const MAX_ATTEMPTS = 3;
const FAILED = /^Failed (\d+)\/\d+ \[([^\]]+)\]/;

export const notificationsEnabled = () => Boolean(config.makeWebhookUrl && config.makeWebhookSecret);

/** Whether a status change should notify the album admin. */
export const notifies = (status) => status in EVENTS;

const RETRY_BACKOFF_MS = 30_000;

/**
 * A failed notification due for another attempt: returns the status it was for, or null. Attempt n waits
 * n × 30 s after the row last changed (the Updated field), so a short outage is ridden out.
 */
export function retryDue(row, now = Date.now()) {
  const m = String(row.Notification ?? '').match(FAILED);
  if (!m || Number(m[1]) >= MAX_ATTEMPTS || m[2] !== row.Status?.value) return null;
  const since = now - Date.parse(row.Updated ?? 0);
  return since >= Number(m[1]) * RETRY_BACKOFF_MS ? m[2] : null;
}

/** Sends one notification; returns the text for the Notification field. Never throws. */
export async function sendNotification(row, status, values, log) {
  const previous = String(row.Notification ?? '').match(FAILED);
  const attempt = previous && previous[2] === status ? Number(previous[1]) + 1 : 1;
  const body = {
    secret: config.makeWebhookSecret,
    event: EVENTS[status],
    submission: row.id,
    status,
    album: row.Album?.[0]?.value ?? '',
    photo: row.Photo?.[0]?.value ?? '',
    submittedBy: row['Submitted by'] ?? '',
    aiRisk: values['AI risk'] ?? row['AI risk']?.value ?? '',
    aiFindings: values['AI findings'] ?? row['AI findings'] ?? '',
    adminComment: values['Admin comment'] ?? row['Admin comment'] ?? '',
    taskUrl: `${config.operatonUrl.replace(/\/engine-rest$/, '')}/operaton/app/tasklist/default/`,
    sentAt: new Date().toISOString(),
  };
  const started = Date.now();
  try {
    const res = await fetch(config.makeWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Make answers plain "Accepted" when the scenario sends no response of its own.
    }
    const ms = Date.now() - started;
    if (res.ok && json?.ok === true) {
      log('notified', `submission ${row.id} (${status}) via Make in ${ms} ms`);
      return `Notified [${status}] ${new Date().toISOString()}`;
    }
    if (res.ok && !json) {
      log('notified?', `submission ${row.id} (${status}): Make accepted but did not confirm (${text.slice(0, 40)})`);
      return `Sent, not confirmed [${status}] ${new Date().toISOString()}`;
    }
    throw new Error(json?.error || `HTTP ${res.status} ${text.slice(0, 120)}`);
  } catch (err) {
    const message = err.name === 'TimeoutError' ? 'Make did not answer within 30 s' : err.message;
    log('notify failed', `submission ${row.id} (${status}) attempt ${attempt}/${MAX_ATTEMPTS}: ${message}`);
    return `Failed ${attempt}/${MAX_ATTEMPTS} [${status}] ${message}`.slice(0, 250);
  }
}
