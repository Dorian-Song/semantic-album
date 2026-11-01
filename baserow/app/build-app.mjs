// Builds the "Semantic Album" application in Baserow's Application Builder on top of the Photo Album database:
//   /                 albums (table, links to each album)
//   /album/:album_id  the album's photos (thumbnails, file names, captions)
//   /submit           photo submission form + the list of submissions with their review status,
//                     with Withdraw (update row) and Delete (delete row) buttons
// The script replaces an existing application of the same name, so it can be rerun after changes.
//
// Auth: BASEROW_JWT, or BASEROW_EMAIL + BASEROW_PASSWORD. URL: BASEROW_URL (default http://localhost:8085).
const BASE = (process.env.BASEROW_URL || 'http://localhost:8085').replace(/\/$/, '') + '/api';
const APP_NAME = 'Semantic Album';
const DATABASE = 'Photo Album';

let jwt = process.env.BASEROW_JWT;
async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `JWT ${jwt}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 600)}`);
  return text ? JSON.parse(text) : null;
}
if (!jwt) {
  const res = await fetch(`${BASE}/user/token-auth/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.BASEROW_EMAIL, password: process.env.BASEROW_PASSWORD }),
  });
  if (!res.ok) throw new Error('Set BASEROW_JWT, or BASEROW_EMAIL and BASEROW_PASSWORD');
  jwt = (await res.json()).access_token;
}

// --- Find the database, tables and fields by name ---------------------------------------------------------------
const workspaces = await call('GET', '/workspaces/');
let database, workspaceId;
for (const w of workspaces) {
  const apps = await call('GET', `/applications/workspace/${w.id}/`);
  const found = apps.find((a) => a.type === 'database' && a.name === DATABASE);
  if (found) [database, workspaceId] = [found, w.id];
}
if (!database) throw new Error(`Database "${DATABASE}" not found`);
const tables = Object.fromEntries((await call('GET', `/database/tables/database/${database.id}/`)).map((t) => [t.name, t.id]));
const fields = {};
for (const [name, id] of Object.entries(tables)) {
  fields[name] = Object.fromEntries((await call('GET', `/database/fields/table/${id}/`)).map((f) => [f.name, f.id]));
}
const A = fields.Albums, P = fields.Photos, S = fields.Submissions;
const rec = (fieldId, path = '') => `get('current_record.field_${fieldId}${path}')`;

// --- Application, integration, pages ---------------------------------------------------------------------------
for (const a of await call('GET', `/applications/workspace/${workspaceId}/`)) {
  if (a.type === 'builder' && a.name === APP_NAME) await call('DELETE', `/applications/${a.id}/`);
}
const app = await call('POST', `/applications/workspace/${workspaceId}/`, { type: 'builder', name: APP_NAME });
const local = await call('POST', `/application/${app.id}/integrations/`, { type: 'local_baserow', name: 'Local Baserow' });
const page = (name, path, path_params = []) => call('POST', `/builder/${app.id}/pages/`, { name, path, path_params });
const home = await page('Albums', '/');
const albumPage = await page('Album', '/album/:album_id', [{ name: 'album_id', type: 'numeric' }]);
const submitPage = await page('Submit a photo', '/submit');
// The default page created with a new application is not used.
for (const p of (await call('GET', `/applications/${app.id}/`)).pages) {
  if (!p.shared && ![home.id, albumPage.id, submitPage.id].includes(p.id)) await call('DELETE', `/builder/page/${p.id}/`);
}

/** Formulas in a data source (row id, filters) are only accepted once it exists, so they go in an update. */
async function dataSource(pageId, name, type, tableId, extra) {
  const ds = await call('POST', `/builder/page/${pageId}/data-sources/`, { name, type, integration_id: local.id, table_id: tableId });
  return extra ? call('PATCH', `/builder/data-source/${ds.id}/`, extra) : ds;
}
/**
 * Baserow 2.4 places elements relative to a reference element: the first child of a container goes in as
 * "child" of it, later ones "south" of the previous child. Top-level elements are appended in creation order.
 */
const lastChild = new Map();
async function element(pageId, type, { parent_element_id, ...props } = {}) {
  const placement = {};
  if (parent_element_id) {
    const previous = lastChild.get(parent_element_id);
    Object.assign(placement, previous ? { reference_element_id: previous, position: 'south' } : { reference_element_id: parent_element_id, position: 'child' });
  }
  const el = await call('POST', `/builder/page/${pageId}/elements/`, { type, ...placement, ...props });
  if (parent_element_id) lastChild.set(parent_element_id, el.id);
  return el;
}
/** Workflow actions likewise get their formulas (titles, row id, field values) in an update. */
async function action(pageId, type, { element_id, event, ...rest }) {
  const wa = await call('POST', `/builder/page/${pageId}/workflow_actions/`, { type, element_id, event });
  return Object.keys(rest).length ? call('PATCH', `/builder/workflow_action/${wa.id}/`, rest) : wa;
}
/** Collection elements take their columns through an update after creation. */
async function collection(pageId, type, props, columns) {
  const el = await element(pageId, type, props);
  return columns ? call('PATCH', `/builder/element/${el.id}/`, { fields: columns }) : el;
}
const nav = (pageId, toPage, label, params = []) =>
  element(pageId, 'link', { value: `'${label}'`, navigation_type: 'page', navigate_to_page_id: toPage.id, page_parameters: params, variant: 'link' });

async function header(pageId, title, subtitle) {
  await nav(pageId, home, 'Albums');
  await nav(pageId, submitPage, 'Submit a photo');
  await element(pageId, 'heading', { value: `'${title}'`, level: 1 });
  if (subtitle) await element(pageId, 'text', { value: `'${subtitle}'` });
}

// --- Albums ----------------------------------------------------------------------------------------------------
{
  const albums = await dataSource(home.id, 'Albums', 'local_baserow_list_rows', tables.Albums, { sortings: [{ field: A.Name, order_by: 'ASC' }] });
  await header(home.id, 'Semantic Album', 'Albums and photo descriptions from the local library, kept in Baserow.');
  await collection(home.id, 'table', { data_source_id: albums.id, items_per_page: 20 }, [
    {
      name: 'Album',
      type: 'link',
      navigation_type: 'page',
      navigate_to_page_id: albumPage.id,
      page_parameters: [{ name: 'album_id', value: "get('current_record.id')" }],
      link_name: rec(A.Name),
    },
    { name: 'Photos', type: 'text', value: rec(A['Photo count']) },
    { name: 'Created', type: 'text', value: rec(A['Created date']) },
  ]);
}

// --- Album -----------------------------------------------------------------------------------------------------
{
  const album = await dataSource(albumPage.id, 'Album', 'local_baserow_get_row', tables.Albums, { row_id: "get('page_parameter.album_id')" });
  const photos = await dataSource(albumPage.id, 'Photos in album', 'local_baserow_list_rows', tables.Photos, {
    filters: [{ field: P.Albums, type: 'link_row_has', value: "get('page_parameter.album_id')", value_is_formula: true }],
  });
  await nav(albumPage.id, home, 'Albums');
  await nav(albumPage.id, submitPage, 'Submit a photo');
  await element(albumPage.id, 'heading', { value: `get('data_source.${album.id}.field_${A.Name}')`, level: 1 });
  await element(albumPage.id, 'text', { value: `concat(get('data_source.${album.id}.field_${A['Photo count']}'), ' photos')` });
  const repeat = await element(albumPage.id, 'repeat', {
    data_source_id: photos.id,
    items_per_page: 24,
    orientation: 'horizontal',
    items_per_row: { desktop: 4, tablet: 2, smartphone: 1 },
  });
  await element(albumPage.id, 'image', { parent_element_id: repeat.id, image_source_type: 'url', image_url: rec(P.Thumbnail), alt_text: rec(P['File name']) });
  await element(albumPage.id, 'text', { parent_element_id: repeat.id, value: rec(P['File name']) });
  await element(albumPage.id, 'text', { parent_element_id: repeat.id, value: rec(P.Caption) });
}

// --- Submit a photo --------------------------------------------------------------------------------------------
{
  const photos = await dataSource(submitPage.id, 'All photos', 'local_baserow_list_rows', tables.Photos);
  const albums = await dataSource(submitPage.id, 'All albums', 'local_baserow_list_rows', tables.Albums);
  const submissions = await dataSource(submitPage.id, 'Submissions', 'local_baserow_list_rows', tables.Submissions, { sortings: [{ field: S.Created, order_by: 'DESC' }] });

  await header(submitPage.id, 'Submit a photo', 'An AI privacy check runs first; photos that may show people or personal data wait for an album admin.');
  const form = await element(submitPage.id, 'form_container', { submit_button_label: "'Submit for review'", reset_initial_values_post_submission: true });
  const photo = await element(submitPage.id, 'record_selector', {
    parent_element_id: form.id,
    data_source_id: photos.id,
    label: "'Photo'",
    required: true,
    items_per_page: 20,
    property_options: [{ schema_property: `field_${P['File name']}`, searchable: true, filterable: false, sortable: false }],
    option_name_suffix: rec(P['File name']),
  });
  const albumSel = await element(submitPage.id, 'record_selector', {
    parent_element_id: form.id,
    data_source_id: albums.id,
    label: "'Shared album'",
    required: true,
    items_per_page: 20,
  });
  const who = await element(submitPage.id, 'input_text', { parent_element_id: form.id, label: "'Your name'", required: true, placeholder: "'alex'" });
  const note = await element(submitPage.id, 'input_text', { parent_element_id: form.id, label: "'Note for the album admin'", required: false, is_multiline: true, rows: 3 });

  await action(submitPage.id, 'create_row', {
    element_id: form.id,
    event: 'submit',
    service: {
      integration_id: local.id,
      table_id: tables.Submissions,
      field_mappings: [
        { field_id: S.Photo, value: `get('form_data.${photo.id}')`, enabled: true },
        { field_id: S.Album, value: `get('form_data.${albumSel.id}')`, enabled: true },
        { field_id: S['Submitted by'], value: `get('form_data.${who.id}')`, enabled: true },
        { field_id: S.Note, value: `get('form_data.${note.id}')`, enabled: true },
        { field_id: S.Status, value: "'Submitted'", enabled: true },
      ],
    },
  });
  await action(submitPage.id, 'notification', { element_id: form.id, event: 'submit', title: "'Submitted'", description: "'The AI check starts within a few seconds.'" });
  await action(submitPage.id, 'refresh_data_source', { element_id: form.id, event: 'submit', data_source_id: submissions.id });

  await element(submitPage.id, 'heading', { value: "'Submissions'", level: 2 });
  const list = await collection(submitPage.id, 'table', { data_source_id: submissions.id, items_per_page: 20 }, [
    { name: 'Submission', type: 'text', value: rec(S.Submission) },
    { name: 'Photo', type: 'text', value: rec(S.Photo, '.*.value') },
    { name: 'Album', type: 'text', value: rec(S.Album, '.*.value') },
    { name: 'By', type: 'text', value: rec(S['Submitted by']) },
    { name: 'Status', type: 'text', value: rec(S.Status, '.value') },
    { name: 'AI risk', type: 'text', value: rec(S['AI risk'], '.value') },
    { name: 'AI findings', type: 'text', value: rec(S['AI findings']) },
    { name: 'Admin comment', type: 'text', value: rec(S['Admin comment']) },
    { name: 'Withdraw', type: 'button', label: "'Withdraw'" },
    { name: 'Delete', type: 'button', label: "'Delete'" },
  ]);
  const button = (label) => list.fields.find((f) => f.name === label).uid;
  await action(submitPage.id, 'update_row', {
    element_id: list.id,
    event: `${button('Withdraw')}_click`,
    service: {
      integration_id: local.id,
      table_id: tables.Submissions,
      row_id: "get('current_record.id')",
      field_mappings: [{ field_id: S.Status, value: "'Withdrawn'", enabled: true }],
    },
  });
  await action(submitPage.id, 'refresh_data_source', { element_id: list.id, event: `${button('Withdraw')}_click`, data_source_id: submissions.id });
  await action(submitPage.id, 'delete_row', {
    element_id: list.id,
    event: `${button('Delete')}_click`,
    service: { integration_id: local.id, table_id: tables.Submissions, row_id: "get('current_record.id')" },
  });
  await action(submitPage.id, 'refresh_data_source', { element_id: list.id, event: `${button('Delete')}_click`, data_source_id: submissions.id });
}

console.log(`Built "${APP_NAME}" (application ${app.id}). Preview: ${BASE.replace(/\/api$/, '')}/builder/preview/${app.id}/`);
