import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  evaluateRuleCorpus,
  renderEvaluationReport,
  ruleCorpusSchema,
} from '../dist/packages/evaluation/src/index.js';

const manifestPath = resolve('fixtures/evaluation/rule-cases.json');

async function manifest() {
  return JSON.parse(await readFile(manifestPath, 'utf8'));
}

test('validates at least twenty unique synthetic cases spanning every rule', async () => {
  const value = await manifest();
  const parsed = ruleCorpusSchema.parse(value);
  assert.equal(parsed.cases.length, 24);
  assert.deepEqual([...new Set(parsed.cases.map(testCase => testCase.ruleId))], [
    'ST-001', 'ST-002', 'ST-003',
  ]);
  assert.equal(new Set(parsed.cases.map(testCase => testCase.id)).size, 24);
  assert.equal(JSON.stringify(value).includes('myshopify.com'), false);
});

test('reports deterministic aggregate and per-rule precision without expected-result drift', async () => {
  const report = evaluateRuleCorpus(await manifest());
  assert.deepEqual(report.aggregate, {
    ruleId: 'all', caseCount: 24,
    truePositive: 5, falsePositive: 0, trueNegative: 7, falseNegative: 0,
    inconclusive: 10, notApplicable: 2, precision: 1,
  });
  assert.deepEqual(report.byRule, [
    {
      ruleId: 'ST-001', caseCount: 8,
      truePositive: 1, falsePositive: 0, trueNegative: 3, falseNegative: 0,
      inconclusive: 4, notApplicable: 0, precision: 1,
    },
    {
      ruleId: 'ST-002', caseCount: 8,
      truePositive: 2, falsePositive: 0, trueNegative: 2, falseNegative: 0,
      inconclusive: 3, notApplicable: 1, precision: 1,
    },
    {
      ruleId: 'ST-003', caseCount: 8,
      truePositive: 2, falsePositive: 0, trueNegative: 2, falseNegative: 0,
      inconclusive: 3, notApplicable: 1, precision: 1,
    },
  ]);
  assert.equal(report.cases.every(testCase => testCase.matchesExpected), true);
  assert.equal(renderEvaluationReport(report), renderEvaluationReport(evaluateRuleCorpus(await manifest())));
});

test('standalone runner prints only the reproducible synthetic JSON report', () => {
  const result = spawnSync(process.execPath, [
    resolve('dist/packages/evaluation/src/cli.js'), manifestPath,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.corpus.caseCount, 24);
  assert.equal(report.aggregate.precision, 1);
  assert.equal('generatedAt' in report, false);
});
