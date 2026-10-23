// Builds the "Album enrichment" workflow definition. deploy.mjs fills in the IDs that differ per n8n instance.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

const code = (file) => fs.readFileSync(new URL(`./code/${file}`, import.meta.url), 'utf8');

export const WORKFLOW_NAME = 'Album enrichment';
export const TABLE_NAME = 'album_enrichment';
export const CREDENTIAL_NAME = 'Album webhook secret';
export const ENRICH_PATH = 'album-enrichment';
export const PURGE_PATH = 'album-enrichment/purge';

export const TABLE_COLUMNS = [
  { name: 'key', type: 'string' },
  { name: 'assetId', type: 'string' },
  { name: 'revision', type: 'number' },
  { name: 'caption', type: 'string' },
  { name: 'tags', type: 'string' },
  { name: 'keywords', type: 'string' },
  { name: 'categories', type: 'string' },
  { name: 'wordCount', type: 'number' },
];

const split = (field) => `($json.${field} ? $json.${field}.split(', ') : [])`;

/**
 * @param {{ tableId: string, credential: { id: string, name: string }, webhookIds?: { enrich?: string, purge?: string } }} ids
 */
export function buildWorkflow({ tableId, credential, webhookIds = {} }) {
  const table = { __rl: true, mode: 'id', value: tableId };
  const auth = { httpHeaderAuth: { id: credential.id, name: credential.name } };
  const nodes = [
    {
      id: randomUUID(),
      name: 'Receive caption',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2.1,
      position: [0, 0],
      webhookId: webhookIds.enrich ?? randomUUID(),
      parameters: { httpMethod: 'POST', path: ENRICH_PATH, authentication: 'headerAuth', responseMode: 'responseNode', options: {} },
      credentials: auth,
    },
    {
      id: randomUUID(),
      name: 'Validate and normalize',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [220, 0],
      parameters: { mode: 'runOnceForEachItem', jsCode: code('normalize-caption.js') },
    },
    {
      id: randomUUID(),
      name: 'Valid?',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [440, 0],
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            {
              id: randomUUID(),
              leftValue: '={{ $json.valid }}',
              rightValue: '',
              operator: { type: 'boolean', operation: 'true', singleValue: true },
            },
          ],
          combinator: 'and',
        },
        options: {},
      },
    },
    {
      id: randomUUID(),
      name: 'Build row',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [660, -100],
      parameters: { mode: 'runOnceForEachItem', jsCode: '// The Data Table record, column for column.\nreturn { json: $json.row };' },
    },
    {
      id: randomUUID(),
      name: 'Upsert enrichment row',
      type: 'n8n-nodes-base.dataTable',
      typeVersion: 1.1,
      position: [880, -100],
      parameters: {
        resource: 'row',
        operation: 'upsert',
        dataTableId: table,
        matchType: 'allConditions',
        filters: { conditions: [{ keyName: 'key', condition: 'eq', keyValue: '={{ $json.key }}' }] },
        columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [] },
        options: {},
      },
    },
    {
      id: randomUUID(),
      name: 'Read row back',
      type: 'n8n-nodes-base.dataTable',
      typeVersion: 1.1,
      position: [1100, -100],
      parameters: {
        resource: 'row',
        operation: 'get',
        dataTableId: table,
        matchType: 'allConditions',
        filters: { conditions: [{ keyName: 'key', condition: 'eq', keyValue: "={{ $('Build row').item.json.key }}" }] },
        returnAll: false,
        limit: 1,
      },
    },
    {
      id: randomUUID(),
      name: 'Return enrichment',
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1.5,
      position: [1320, -100],
      parameters: {
        respondWith: 'json',
        responseBody:
          '={{ JSON.stringify({ key: $json.key, assetId: $json.assetId, revision: $json.revision, caption: $json.caption, ' +
          `tags: ${split('tags')}, keywords: ${split('keywords')}, categories: ${split('categories')}, ` +
          'wordCount: $json.wordCount, rowId: $json.id, storedAt: $json.updatedAt }) }}',
        options: {},
      },
    },
    {
      id: randomUUID(),
      name: 'Reject invalid request',
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1.5,
      position: [660, 100],
      parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify({ error: $json.error }) }}', options: { responseCode: 422 } },
    },
    {
      id: randomUUID(),
      name: 'Receive purge request',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2.1,
      position: [0, 320],
      webhookId: webhookIds.purge ?? randomUUID(),
      parameters: { httpMethod: 'POST', path: PURGE_PATH, authentication: 'headerAuth', responseMode: 'responseNode', options: {} },
      credentials: auth,
    },
    {
      id: randomUUID(),
      name: 'Validate purge',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [220, 320],
      parameters: { mode: 'runOnceForEachItem', jsCode: code('validate-purge.js') },
    },
    {
      id: randomUUID(),
      name: 'Delete photo rows',
      type: 'n8n-nodes-base.dataTable',
      typeVersion: 1.1,
      position: [440, 320],
      alwaysOutputData: true,
      parameters: {
        resource: 'row',
        operation: 'deleteRows',
        dataTableId: table,
        matchType: 'allConditions',
        filters: { conditions: [{ keyName: 'assetId', condition: 'eq', keyValue: '={{ $json.assetId }}' }] },
        options: {},
      },
    },
    {
      id: randomUUID(),
      name: 'Return purge result',
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1.5,
      position: [660, 320],
      parameters: {
        respondWith: 'json',
        responseBody:
          "={{ JSON.stringify({ assetId: $('Validate purge').first().json.assetId, deleted: $input.all().filter(i => i.json.id !== undefined).length }) }}",
        options: {},
      },
    },
  ];
  const link = (to, index = 0) => ({ node: to, type: 'main', index });
  const connections = {
    'Receive caption': { main: [[link('Validate and normalize')]] },
    'Validate and normalize': { main: [[link('Valid?')]] },
    'Valid?': { main: [[link('Build row')], [link('Reject invalid request')]] },
    'Build row': { main: [[link('Upsert enrichment row')]] },
    'Upsert enrichment row': { main: [[link('Read row back')]] },
    'Read row back': { main: [[link('Return enrichment')]] },
    'Receive purge request': { main: [[link('Validate purge')]] },
    'Validate purge': { main: [[link('Delete photo rows')]] },
    'Delete photo rows': { main: [[link('Return purge result')]] },
  };
  return { name: WORKFLOW_NAME, nodes, connections, settings: { executionOrder: 'v1' } };
}
