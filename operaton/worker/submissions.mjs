// Connects the Baserow "Submissions" table (filled by the Semantic Album app built in Baserow) to Operaton:
//   new row (Status = Submitted)       -> start a photo-review process, store its id, Status = AI review
//   row set to Withdrawn by the user   -> cancel the running process
//   every row with a running process   -> copy status, AI risk and findings, and the admin's comment back
import { config, request } from './config.mjs';

const engine = config.operatonUrl;
const FINAL = new Set(['Published', 'Rejected', 'Withdrawn', 'Error']);

const baserow = (path, opts = {}) =>
  request(`${config.baserowUrl}/api/database/rows/table/${path}`, { ...opts, headers: { Authorization: `Token ${config.baserowToken}` } });
const rows = async (table) => {
  const out = [];
  for (let page = 1; ; page++) {
    const r = await baserow(`${table}/?user_field_names=true&size=200&page=${page}`);
    out.push(...r.results);
    if (!r.next) return out;
  }
};
const updateRow = (id, values) => baserow(`${config.submissionsTable}/${id}/?user_field_names=true`, { method: 'PATCH', body: values });
const selected = (v) => v?.value ?? null;
const linked = (v) => (Array.isArray(v) && v.length ? v[0] : null);

async function operatonUser(id) {
  if (!id) return null;
  const found = await request(`${engine}/user?id=${encodeURIComponent(id)}`);
  return found.length ? id : null;
}

async function start(row, log) {
  const photo = linked(row.Photo);
  const album = linked(row.Album);
  if (!photo || !album) {
    await updateRow(row.id, { Status: 'Error', 'AI findings': 'A photo and an album are both required.' });
    return;
  }
  const photoRow = await baserow(`${config.photosTable}/${photo.id}/?user_field_names=true`);
  const submitter = await operatonUser(String(row['Submitted by'] ?? '').trim().toLowerCase());
  const instance = await request(`${engine}/process-definition/key/photo-review/start`, {
    method: 'POST',
    body: {
      businessKey: `baserow-submission-${row.id}`,
      variables: {
        photoId: { value: photoRow['Photo ID'], type: 'String' },
        albumName: { value: album.value, type: 'String' },
        note: { value: row.Note ?? '', type: 'String' },
        // Unknown names leave the revise step to the contributors group.
        submitter: submitter ? { value: submitter, type: 'String' } : { value: null, type: 'Null' },
        submissionRow: { value: row.id, type: 'Integer' },
      },
    },
  });
  await updateRow(row.id, { 'Process ID': instance.id, Status: 'AI review' });
  log('started', `submission ${row.id} -> process ${instance.id.slice(0, 8)}`);
}

async function currentState(processId) {
  const [hist, vars] = await Promise.all([
    request(`${engine}/history/process-instance/${processId}`).catch((e) => (e.status === 404 ? null : Promise.reject(e))),
    request(`${engine}/history/variable-instance?processInstanceId=${processId}`),
  ]);
  const v = Object.fromEntries(vars.map((x) => [x.name, x.value]));
  let status;
  if (!hist) status = 'Error';
  else if (hist.state === 'COMPLETED') status = v.status === 'published' ? 'Published' : 'Rejected';
  else if (hist.state !== 'ACTIVE') status = 'Withdrawn';
  else if ((await request(`${engine}/incident?processInstanceId=${processId}`)).length) status = 'Error';
  else {
    const tasks = await request(`${engine}/task?processInstanceId=${processId}`);
    const names = tasks.map((t) => t.taskDefinitionKey);
    status = names.includes('review') ? 'Waiting for admin' : names.includes('revise') ? 'Changes requested' : 'AI review';
  }
  return {
    Status: status,
    'AI risk': v.aiRisk ?? null,
    'AI findings': v.aiReasons ?? '',
    'Admin comment': v.reviewComment ?? '',
  };
}

/** One pass over the Submissions table. */
export async function syncSubmissions(log) {
  for (const row of await rows(config.submissionsTable)) {
    const status = selected(row.Status);
    const processId = row['Process ID'];
    if (status === 'Submitted' && !processId) {
      await start(row, log);
    } else if (status === 'Withdrawn' && processId) {
      const active = await request(`${engine}/process-instance/${processId}`).catch(() => null);
      if (active) {
        await request(`${engine}/process-instance/${processId}?skipCustomListeners=true`, { method: 'DELETE' });
        log('withdrawn', `submission ${row.id} -> process ${processId.slice(0, 8)} cancelled`);
      }
    } else if (processId && !FINAL.has(status)) {
      const next = await currentState(processId);
      const same =
        next.Status === status &&
        next['AI risk'] === selected(row['AI risk']) &&
        next['AI findings'] === (row['AI findings'] ?? '') &&
        next['Admin comment'] === (row['Admin comment'] ?? '');
      if (!same) {
        await updateRow(row.id, next);
        log('status', `submission ${row.id}: ${next.Status}`);
      }
    }
  }
}
