// Deploys the photo-review process and creates the demo participants, groups and Tasklist filters.
// Safe to run again: existing users, groups and filters are kept, and an unchanged process is not redeployed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, request } from './config.mjs';

const api = config.operatonUrl;
const here = path.dirname(fileURLToPath(import.meta.url));

const groups = [
  { id: 'contributors', name: 'Contributors', type: 'WORKFLOW' },
  { id: 'albumAdmins', name: 'Album admins', type: 'WORKFLOW' },
];
const users = [
  { id: 'alex', firstName: 'Alex', lastName: 'Contributor', email: 'alex@example.com', password: 'alex-demo', groups: ['contributors'] },
  { id: 'sam', firstName: 'Sam', lastName: 'Admin', email: 'sam@example.com', password: 'sam-demo', groups: ['albumAdmins'] },
];
const filters = [
  { name: 'My tasks', query: { assigneeExpression: '${currentUser()}' }, priority: -10 },
  { name: 'My group tasks', query: { candidateGroupsExpression: '${currentUserGroups()}' }, priority: -5 },
];

async function deploy() {
  const bpmn = fs.readFileSync(path.resolve(here, '../processes/photo-review.bpmn'));
  const form = new FormData();
  form.append('deployment-name', 'photo-review');
  form.append('enable-duplicate-filtering', 'true');
  form.append('deploy-changed-only', 'true');
  form.append('deployment-source', 'album-setup');
  form.append('photo-review.bpmn', new Blob([bpmn], { type: 'application/xml' }), 'photo-review.bpmn');
  const res = await fetch(`${api}/deployment/create`, { method: 'POST', body: form });
  const json = await res.json();
  if (!res.ok) throw new Error(`deployment failed: ${json.message}`);
  const defs = Object.values(json.deployedProcessDefinitions ?? {});
  console.log(defs.length ? `deployed ${defs.map((d) => `${d.key} v${d.version}`).join(', ')}` : 'process unchanged, not redeployed');
}

async function setupIdentity() {
  for (const g of groups) {
    const found = await request(`${api}/group?id=${g.id}`);
    if (!found.length) await request(`${api}/group/create`, { method: 'POST', body: g });
  }
  for (const { password, groups: memberOf, ...profile } of users) {
    const found = await request(`${api}/user?id=${profile.id}`);
    if (!found.length) await request(`${api}/user/create`, { method: 'POST', body: { profile, credentials: { password } } });
    for (const g of memberOf) {
      const member = await request(`${api}/user?id=${profile.id}&memberOfGroup=${g}`);
      if (!member.length) await request(`${api}/group/${g}/members/${profile.id}`, { method: 'PUT' });
    }
  }
  console.log(`users: ${users.map((u) => `${u.id} (${u.groups.join(', ')})`).join('; ')}`);
}

async function setupFilters() {
  const existing = await request(`${api}/filter?resourceType=Task`);
  for (const f of filters) {
    if (existing.some((e) => e.name === f.name)) continue;
    await request(`${api}/filter/create`, {
      method: 'POST',
      body: { resourceType: 'Task', name: f.name, owner: null, query: f.query, properties: { priority: f.priority, refresh: true, description: '' } },
    });
  }
  console.log(`filters: ${filters.map((f) => f.name).join(', ')}`);
}

await deploy();
await setupIdentity();
await setupFilters();
