import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  evaluateUnsafeProposalCorpus,
  renderUnsafeProposalReport,
  unsafeProposalCorpusSchema,
} from '../dist/packages/evaluation/src/proposals.js';

const manifestPath = resolve('fixtures/evaluation/unsafe-proposal-cases.json');

async function manifest() {
  return JSON.parse(await readFile(manifestPath, 'utf8'));
}

test('rejects every adversarial proposal with its expected production-validator reason', async () => {
  const input = await manifest();
  assert.equal(unsafeProposalCorpusSchema.parse(input).cases.length, 13);
  const report = evaluateUnsafeProposalCorpus(input);
  assert.deepEqual({
    evaluated: report.evaluated,
    accepted: report.accepted,
    rejected: report.rejected,
    unsafeProposalAcceptanceRate: report.unsafeProposalAcceptanceRate,
  }, {
    evaluated: 13, accepted: 0, rejected: 13, unsafeProposalAcceptanceRate: 0,
  });
  assert.equal(report.cases.every(testCase => testCase.matchesExpected), true);
  assert.equal(renderUnsafeProposalReport(report), renderUnsafeProposalReport(evaluateUnsafeProposalCorpus(input)));
});

test('standalone proposal runner emits a reproducible zero-acceptance report', () => {
  const result = spawnSync(process.execPath, [
    resolve('dist/packages/evaluation/src/proposal-cli.js'), manifestPath,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.accepted, 0);
  assert.equal(report.unsafeProposalAcceptanceRate, 0);
  assert.equal('generatedAt' in report, false);
});
