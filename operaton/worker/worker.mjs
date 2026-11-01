// External-task worker for the photo-review process. Long-polls Operaton for two topics:
//   ai-review — privacy check of a submitted photo by DeepSeek, using the photo's text only (never the image)
//   publish   — adds the photo to the shared album in Album and saves the reviewed caption
// It also turns rows of the Baserow Submissions table into processes and writes their status back (submissions.mjs).
// Run with: node operaton/worker/worker.mjs   (settings and keys are read from Album/.env)
import { config, request } from './config.mjs';
import { syncSubmissions } from './submissions.mjs';

const WORKER_ID = 'album-worker';
const LOCK_MS = 120_000;
const RETRIES = 3;
const RETRY_WAIT_MS = 15_000;
const engine = config.operatonUrl;

const log = (...args) => console.log(new Date().toISOString(), ...args);
const str = (value) => ({ value, type: 'String' });

/** A problem retrying cannot fix (for example an unknown photo id): the task becomes an incident at once. */
class PermanentError extends Error {}

// --- Album API -----------------------------------------------------------------------------------------------

function album(path, { method = 'GET', body, key } = {}) {
  const headers = { 'X-API-Key': config.albumApiKey };
  // Album requires an Idempotency-Key on changes; keyed on the external task, so a retried step cannot act twice.
  if (method !== 'GET') headers['Idempotency-Key'] = key;
  return request(`${config.albumUrl}${path}`, { method, headers, body }).catch((err) => {
    if (err.status === 404 || err.status === 400) throw new PermanentError(err.message);
    throw err;
  });
}

// --- DeepSeek ------------------------------------------------------------------------------------------------

const INSTRUCTIONS = `You check photos before they are published to a shared album that friends and family can see.
You never see the image. You get the photo's AI-written description, tags, detected objects and any text read from it.
Rate the privacy risk of publishing it:
- high: readable personal data (ID or card numbers, addresses, phone numbers, licence plates, documents, screens with private information) or a sensitive or embarrassing situation;
- medium: identifiable people's faces, children, the inside of a private home, or anything you cannot judge from the text;
- low: landscapes, buildings, food, animals, objects, or people too far away or too small to identify.
Answer with JSON only: {"risk": "low" | "medium" | "high", "reasons": ["short reason", ...]} with one to three reasons.`;

function outputText(json) {
  if (typeof json?.output_text === 'string') return json.output_text;
  return (json?.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((c) => c.type === 'output_text')
    .map((c) => c.text)
    .join('');
}

async function assessPrivacy(facts) {
  if (!config.deepseekKey) throw new Error('DEEPSEEK_API_KEY is not set');
  const json = await request(`${config.deepseekUrl}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.deepseekKey}` },
    body: {
      model: config.deepseekModel,
      instructions: INSTRUCTIONS,
      input: [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify(facts, null, 1) }] }],
      text: { format: { type: 'json_object' } },
      reasoning: { effort: 'none' },
      max_output_tokens: 400,
      temperature: 0.1,
    },
    timeoutMs: 60_000,
  });
  const answer = JSON.parse(outputText(json));
  if (!['low', 'medium', 'high'].includes(answer.risk) || !Array.isArray(answer.reasons)) throw new Error('DeepSeek returned an unexpected answer');
  return { risk: answer.risk, reasons: answer.reasons.map(String).slice(0, 3), model: json.model ?? config.deepseekModel };
}

// --- Topic handlers ------------------------------------------------------------------------------------------

async function aiReview(task, vars) {
  const photoId = String(vars.photoId ?? '').trim();
  const photo = await album(`/api/photos/${encodeURIComponent(photoId)}`);
  const d = photo.description ?? {};
  const common = {
    photoDescription: str(d.effective ?? ''),
    photoLink: str(`${config.webUrl}/photos/${photo.id}`),
    status: str('ai-reviewed'),
  };
  // Without a description there is nothing to judge: a person decides.
  if (!d.effective) {
    return { ...common, aiRisk: str('medium'), aiReasons: str('The photo has no description yet, so the AI could not check it.'), aiModel: str('none') };
  }
  const facts = {
    sharedAlbum: vars.albumName ?? null,
    contributorNote: vars.note ?? null,
    description: d.effective,
    tags: d.tags ?? [],
    objects: d.objects ?? [],
    textInImage: d.text ?? null,
  };
  try {
    const { risk, reasons, model } = await assessPrivacy(facts);
    return { ...common, aiRisk: str(risk), aiReasons: str(reasons.join(' · ')), aiModel: str(model) };
  } catch (err) {
    // Fail safe: when the AI keeps failing, send the photo to a person instead of blocking the process.
    if ((task.retries ?? RETRIES) > 1) throw err;
    return { ...common, aiRisk: str('medium'), aiReasons: str(`AI review unavailable (${err.message}); check manually.`), aiModel: str('none') };
  }
}

async function publish(task, vars) {
  const photoId = String(vars.photoId ?? '').trim();
  const name = String(vars.albumName ?? '').trim();
  const { items } = await album('/api/albums');
  let target = items.find((a) => a.name.toLowerCase() === name.toLowerCase());
  if (!target) target = await album('/api/albums', { method: 'POST', body: { name }, key: `${task.id}-album` });
  const { added } = await album(`/api/photos/${encodeURIComponent(photoId)}/albums`, { method: 'POST', body: { albumId: target.id }, key: `${task.id}-add` });

  const caption = typeof vars.finalCaption === 'string' ? vars.finalCaption.trim() : '';
  let captionChanged = false;
  if (caption) {
    const photo = await album(`/api/photos/${encodeURIComponent(photoId)}`);
    if (caption !== photo.description?.effective) {
      await album(`/api/photos/${encodeURIComponent(photoId)}/description`, { method: 'PATCH', body: { manualCaption: caption }, key: `${task.id}-caption` });
      captionChanged = true;
    }
  }
  return {
    status: str('published'),
    publishedAlbum: str(target.name),
    publishedAt: { value: new Date().toISOString(), type: 'String' },
    publishedBy: str(vars.reviewedBy ? `approved by ${vars.reviewedBy}` : `auto-approved (low risk)`),
    ...(added ? {} : { publishNote: str('The photo was already in this album.') }),
    ...(captionChanged ? { captionUpdated: { value: true, type: 'Boolean' } } : {}),
  };
}

const handlers = {
  'ai-review': { run: aiReview, variables: ['photoId', 'albumName', 'note'] },
  publish: { run: publish, variables: ['photoId', 'albumName', 'finalCaption', 'reviewedBy'] },
};

// --- Engine loop ---------------------------------------------------------------------------------------------

async function handle(task) {
  const vars = Object.fromEntries(Object.entries(task.variables ?? {}).map(([k, v]) => [k, v.value]));
  const label = `${task.topicName} ${task.processInstanceId.slice(0, 8)} photo=${vars.photoId}`;
  try {
    const result = await handlers[task.topicName].run(task, vars);
    const variables = Object.fromEntries(Object.entries(result).filter(([, v]) => v !== undefined));
    await request(`${engine}/external-task/${task.id}/complete`, { method: 'POST', body: { workerId: WORKER_ID, variables } });
    log('done', label, result.aiRisk ? `risk=${result.aiRisk.value}` : result.publishedAlbum ? `album=${result.publishedAlbum.value}` : '');
  } catch (err) {
    const retries = err instanceof PermanentError ? 0 : Math.max(0, (task.retries ?? RETRIES) - 1);
    await request(`${engine}/external-task/${task.id}/failure`, {
      method: 'POST',
      body: { workerId: WORKER_ID, errorMessage: err.message.slice(0, 600), retries, retryTimeout: RETRY_WAIT_MS },
    }).catch((e) => log('could not report failure', e.message));
    log('failed', label, `retries left ${retries}:`, err.message);
  }
}

async function loop() {
  log(`worker ${WORKER_ID} polling ${engine} for ${Object.keys(handlers).join(', ')}`);
  for (;;) {
    try {
      const tasks = await request(`${engine}/external-task/fetchAndLock`, {
        method: 'POST',
        body: {
          workerId: WORKER_ID,
          maxTasks: 5,
          asyncResponseTimeout: 20_000,
          topics: Object.entries(handlers).map(([topicName, h]) => ({ topicName, lockDuration: LOCK_MS, variables: h.variables })),
        },
        timeoutMs: 40_000,
      });
      await Promise.all(tasks.map(handle));
    } catch (err) {
      log('engine not reachable:', err.message);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}

/** Baserow submissions are checked every few seconds when the table is configured. */
async function submissionsLoop() {
  if (!config.baserowToken || !config.submissionsTable) return log('Baserow submissions not configured; skipping');
  log(`watching Baserow table ${config.submissionsTable} for submissions`);
  for (;;) {
    await syncSubmissions(log).catch((err) => log('submissions sync failed:', err.message));
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

await Promise.all([loop(), submissionsLoop()]);
