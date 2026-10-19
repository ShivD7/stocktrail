import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessReleaseReadiness,
  PENDING_LIVE_GATES,
  RELEASE_VERSION,
  REQUIRED_FILES,
  renderReleaseReadiness,
} from '../scripts/release-readiness.mjs';

function passingInput() {
  return {
    requiredFiles: Object.fromEntries(REQUIRED_FILES.map(path => [path, true])),
    gitClean: true,
    buildSucceeded: true,
    cliVersion: RELEASE_VERSION,
    packageReport: {
      version: RELEASE_VERSION,
      files: [
        { path: 'README.md' }, { path: 'package.json' },
        { path: 'dist/apps/cli/src/index.js' },
        { path: 'dist/apps/dashboard/client/index.html' },
        { path: 'dist/packages/evaluation/src/index.js' },
      ],
    },
    ruleReport: {
      corpus: { caseCount: 24 }, aggregate: { precision: 1 },
      byRule: [{ precision: 1 }, { precision: 0.95 }, { precision: 1 }],
      cases: Array.from({ length: 24 }, () => ({ matchesExpected: true })),
    },
    unsafeProposalReport: {
      evaluated: 13, accepted: 0, unsafeProposalAcceptanceRate: 0,
      cases: Array.from({ length: 13 }, () => ({ matchesExpected: true })),
    },
  };
}

test('offline release checks can pass while live and human gates remain pending', () => {
  const report = assessReleaseReadiness(passingInput());
  assert.equal(report.failures, 0);
  assert.equal(report.pending, PENDING_LIVE_GATES.length);
  assert.equal(report.status, 'offline-ready');
  assert.match(renderReleaseReadiness(report), /Shopify was not contacted/);
  assert.match(renderReleaseReadiness(report), /RESULT offline-ready/);
});

test('required files, clean build, package allowlist, and evaluation thresholds fail closed', () => {
  const input = passingInput();
  input.requiredFiles['docs/privacy.md'] = false;
  input.gitClean = false;
  input.buildSucceeded = false;
  input.cliVersion = '0.0.0';
  input.packageReport.files.push({ path: '.stocktrail/private-config.json' });
  input.ruleReport.byRule[1].precision = 0.94;
  input.unsafeProposalReport.accepted = 1;
  input.unsafeProposalReport.unsafeProposalAcceptanceRate = 1 / 13;

  const report = assessReleaseReadiness(input);
  assert.equal(report.status, 'not-ready');
  assert.deepEqual(
    report.checks.filter(result => result.status === 'fail').map(result => result.id),
    ['file:docs/privacy.md', 'git-clean', 'production-build', 'cli-version', 'package-contents', 'rule-evaluation', 'unsafe-proposals'],
  );
});

test('release output never includes unexpected package paths or injected failure details', () => {
  const input = passingInput();
  const privatePath = 'C:/private/shop/config.json';
  input.packageReport.files.push({ path: privatePath });
  const output = renderReleaseReadiness(assessReleaseReadiness(input));
  assert.doesNotMatch(output, /C:\/private|shop\/config|\.stocktrail/);
  assert.match(output, /Package contents: version, required entries, or allowlist check failed/);
});

test('a wrong package version or incomplete evaluation corpus is rejected', () => {
  const input = passingInput();
  input.packageReport.version = '0.0.0';
  input.ruleReport.corpus.caseCount = 19;
  input.unsafeProposalReport.evaluated = 9;
  const report = assessReleaseReadiness(input);
  assert.equal(report.status, 'not-ready');
  assert.equal(report.checks.find(result => result.id === 'package-contents').status, 'fail');
  assert.equal(report.checks.find(result => result.id === 'rule-evaluation').status, 'fail');
  assert.equal(report.checks.find(result => result.id === 'unsafe-proposals').status, 'fail');
});
