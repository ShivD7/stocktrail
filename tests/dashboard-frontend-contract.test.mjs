import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const client = join(process.cwd(), 'apps', 'dashboard', 'client', 'src');

async function source(...names) {
  return (await Promise.all(names.map(name => readFile(join(client, name), 'utf8')))).join('\n');
}

test('dashboard routes expose the complete Phase 5 navigation', async () => {
  const app = await source('App.tsx');
  for (const route of ['#/products', '#/incidents', '#/connection']) {
    assert.match(app, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(app, /proposals/);
  assert.match(app, /document\.title/);
  assert.match(app, /heading\.focus\(\)/);
  assert.match(app, /Skip to content/);
});

test('dashboard mutations use the frozen Phase 5 API routes and prevent duplicate submits', async () => {
  const all = await source('ActionButton.tsx', 'App.tsx', 'Products.tsx', 'ProductDetail.tsx', 'IncidentDetail.tsx', 'RerunButton.tsx', 'ProposalDetail.tsx');
  for (const endpoint of [
    '/api/imports', '/api/monitoring', '/api/scans', '/improve', '/rerun', '/reject', '/apply', '/reconcile', '/revert',
  ]) assert.ok(all.includes(endpoint), `missing ${endpoint}`);
  assert.doesNotMatch(all, /\/api\/tests\/rerun/);
  assert.match(all, /state === 'busy'/);
  assert.match(all, /disabled=/);
});

test('proposal review keeps changed content inert and gates risky actions', async () => {
  const proposal = await source('ProposalDetail.tsx');
  assert.match(proposal, /<del key=/);
  assert.match(proposal, /<ins key=/);
  assert.doesNotMatch(proposal, /dangerouslySetInnerHTML/);
  assert.match(proposal, /`\$\{props\.verb\} \$\{props\.proposal\.id\}`/);
  assert.match(proposal, /acknowledgeWarnings: acknowledge/);
  assert.match(proposal, /hasWarnings && !acknowledge/);
  assert.match(proposal, /Current/);
  assert.match(proposal, /Predicted/);
  assert.match(proposal, /Verified/);
});

test('incident detail uses normalized comparison and incident-scoped evidence', async () => {
  const detail = await source('IncidentDetail.tsx', 'RerunButton.tsx');
  assert.match(detail, /detail\.comparison/);
  assert.match(detail, /\/api\/incidents\/\$\{detail\.id\}\/evidence\/\$\{source\.source\}/);
  assert.match(detail, /\/api\/incidents\/\$\{incidentId\}\/rerun/);
  assert.doesNotMatch(detail, /artifactPath}`/);
});

test('client errors expose stable friendly messages rather than raw responses', async () => {
  const api = await source('api.ts');
  assert.match(api, /errorMessages/);
  assert.doesNotMatch(api, /response\.text\(/);
  assert.match(api, /Redact raw server responses/);
});
