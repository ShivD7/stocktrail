import { access, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RELEASE_VERSION = '0.1.0';

export const REQUIRED_FILES = Object.freeze([
  'README.md',
  'docs/architecture.md',
  'docs/privacy.md',
  'docs/limitations.md',
  'docs/demo-script.md',
  'docs/release-checklist.md',
  'docs/phase-6-evaluation.md',
  'fixtures/evaluation/rule-cases.json',
  'fixtures/evaluation/unsafe-proposal-cases.json',
  '.github/workflows/ci.yml',
]);

export const PENDING_LIVE_GATES = Object.freeze([
  ['live-performance', 'Capture a ten-product performance run against an authorized Shopify store.'],
  ['live-write-revert', 'Complete controlled apply, verify, reconcile, and revert exercises on an authorized store.'],
  ['clean-setup', 'Complete unassisted merchant and developer setup checks on clean machines.'],
  ['remote-ci', 'Confirm the release commit passes both Windows and Ubuntu jobs on GitHub.'],
  ['manual-accessibility', 'Complete keyboard and responsive browser review on the release candidate.'],
  ['release-assets', 'Review demo media and public release materials before publishing.'],
  ['source-tag', 'Create the authorized GitHub source tag after the final commit; this checker does not mutate Git or GitHub.'],
  ['npm-publication', 'npm publication remains pending and requires separate explicit approval.'],
]);

function check(id, label, status, detail) {
  return { id, label, status, detail };
}

function packageCheck(pack) {
  const files = Array.isArray(pack?.files)
    ? pack.files.map(entry => typeof entry === 'string' ? entry : entry?.path).filter(value => typeof value === 'string')
    : [];
  const required = ['README.md', 'package.json', 'dist/apps/cli/src/index.js', 'dist/apps/dashboard/client/index.html'];
  const unexpected = files.filter(path => path !== 'README.md' && path !== 'package.json' && !path.startsWith('dist/'));
  const complete = required.every(path => files.includes(path));
  const versionMatches = pack?.version === RELEASE_VERSION;
  return {
    passed: versionMatches && complete && unexpected.length === 0 && files.length > required.length,
    fileCount: files.length,
  };
}

function ruleEvaluationCheck(report) {
  const caseCount = report?.corpus?.caseCount ?? 0;
  const aggregatePrecision = report?.aggregate?.precision;
  const expectedMatches = Array.isArray(report?.cases) && report.cases.every(result => result.matchesExpected === true);
  const perRulePrecision = Array.isArray(report?.byRule) && report.byRule.length >= 3 &&
    report.byRule.every(result => typeof result.precision === 'number' && result.precision >= 0.95);
  return {
    passed: caseCount >= 20 && typeof aggregatePrecision === 'number' && aggregatePrecision >= 0.95 &&
      expectedMatches && perRulePrecision,
    caseCount,
    aggregatePrecision: typeof aggregatePrecision === 'number' ? aggregatePrecision : null,
  };
}

function unsafeProposalCheck(report) {
  const evaluated = report?.evaluated ?? 0;
  const acceptanceRate = report?.unsafeProposalAcceptanceRate;
  const expectedMatches = Array.isArray(report?.cases) && report.cases.every(result => result.matchesExpected === true);
  return {
    passed: evaluated >= 10 && report?.accepted === 0 && acceptanceRate === 0 && expectedMatches,
    evaluated,
  };
}

export function assessReleaseReadiness(input) {
  const checks = [];
  for (const path of REQUIRED_FILES) {
    const present = input.requiredFiles?.[path] === true;
    checks.push(check(`file:${path}`, `Required file ${path}`, present ? 'pass' : 'fail', present ? 'present' : 'missing'));
  }

  checks.push(check(
    'git-clean', 'Repository state', input.gitClean ? 'pass' : 'fail',
    input.gitClean ? 'no tracked or untracked changes' : 'uncommitted changes are present',
  ));
  checks.push(check(
    'production-build', 'Production build', input.buildSucceeded ? 'pass' : 'fail',
    input.buildSucceeded ? 'completed successfully' : 'did not complete successfully',
  ));
  checks.push(check(
    'cli-version', 'Built CLI version', input.cliVersion === RELEASE_VERSION ? 'pass' : 'fail',
    input.cliVersion === RELEASE_VERSION ? `matches package version ${RELEASE_VERSION}` : 'does not match the release package version',
  ));

  const packed = packageCheck(input.packageReport);
  checks.push(check(
    'package-contents', 'Package contents', packed.passed ? 'pass' : 'fail',
    packed.passed ? `${packed.fileCount} allowlisted files at version ${RELEASE_VERSION}` : 'version, required entries, or allowlist check failed',
  ));

  const rules = ruleEvaluationCheck(input.ruleReport);
  checks.push(check(
    'rule-evaluation', 'Rule evaluation thresholds', rules.passed ? 'pass' : 'fail',
    rules.passed
      ? `${rules.caseCount} cases; aggregate and per-rule precision at least 95%; all expected outcomes matched`
      : 'case count, precision, or expected-outcome threshold failed',
  ));

  const unsafe = unsafeProposalCheck(input.unsafeProposalReport);
  checks.push(check(
    'unsafe-proposals', 'Unsafe proposal threshold', unsafe.passed ? 'pass' : 'fail',
    unsafe.passed
      ? `${unsafe.evaluated} adversarial cases; 0% accepted; all expected rejections matched`
      : 'case count, acceptance rate, or expected-rejection threshold failed',
  ));

  for (const [id, detail] of PENDING_LIVE_GATES) {
    checks.push(check(id, `External gate ${id}`, 'pending', detail));
  }
  const failures = checks.filter(result => result.status === 'fail').length;
  const pending = checks.filter(result => result.status === 'pending').length;
  return { status: failures > 0 ? 'not-ready' : 'offline-ready', failures, pending, checks };
}

export function renderReleaseReadiness(report) {
  const lines = ['StockTrail release readiness (offline; Shopify was not contacted)'];
  for (const result of report.checks) {
    lines.push(`${result.status.toUpperCase()} ${result.label}: ${result.detail}`);
  }
  lines.push(`RESULT ${report.status}; failures=${report.failures}; pending=${report.pending}`);
  return `${lines.join('\n')}\n`;
}

function run(command, args, cwd, timeout = 120_000) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout, windowsHide: true });
  return { succeeded: result.status === 0 && result.error === undefined, stdout: result.stdout ?? '' };
}

function parsePackOutput(stdout) {
  const json = stdout.match(/(\[\s*\{[\s\S]*\}\s*\])\s*$/)?.[1];
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed[0] ?? null : null;
  } catch {
    return null;
  }
}

async function filePresence(root) {
  const entries = await Promise.all(REQUIRED_FILES.map(async path => {
    try {
      await access(resolve(root, path));
      return [path, true];
    } catch {
      return [path, false];
    }
  }));
  return Object.fromEntries(entries);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function collectReleaseEvidence(root, dependencies = {}) {
  const execute = dependencies.execute ?? run;
  const npmCli = dependencies.npmCli ?? process.env.npm_execpath;
  const requiredFiles = dependencies.requiredFiles ?? await filePresence(root);
  const git = execute('git', ['status', '--porcelain', '--untracked-files=all'], root, 30_000);
  let build = { succeeded: false, stdout: '' };
  let cliVersion = null;
  let packageReport = null;
  let ruleReport = null;
  let unsafeProposalReport = null;

  if (npmCli) {
    build = execute(process.execPath, [npmCli, 'run', 'build', '--silent'], root, 180_000);
    if (build.succeeded) {
      const versionResult = execute(process.execPath, [resolve(root, 'dist/apps/cli/src/index.js'), '--version'], root, 30_000);
      if (versionResult.succeeded) cliVersion = versionResult.stdout.trim();
      const packed = execute(process.execPath, [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts'], root, 90_000);
      if (packed.succeeded) packageReport = parsePackOutput(packed.stdout);
      try {
        const [{ evaluateRuleCorpus }, { evaluateUnsafeProposalCorpus }] = await Promise.all([
          import(`${pathToFileURL(resolve(root, 'dist/packages/evaluation/src/index.js')).href}?release-check`),
          import(`${pathToFileURL(resolve(root, 'dist/packages/evaluation/src/proposals.js')).href}?release-check`),
        ]);
        ruleReport = evaluateRuleCorpus(await readJson(resolve(root, 'fixtures/evaluation/rule-cases.json')));
        unsafeProposalReport = evaluateUnsafeProposalCorpus(
          await readJson(resolve(root, 'fixtures/evaluation/unsafe-proposal-cases.json')),
        );
      } catch {
        // The assessment below reports fixed, redacted threshold failures.
      }
    }
  }

  return {
    requiredFiles,
    gitClean: git.succeeded && git.stdout.trim() === '',
    buildSucceeded: build.succeeded,
    cliVersion,
    packageReport,
    ruleReport,
    unsafeProposalReport,
  };
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const report = assessReleaseReadiness(await collectReleaseEvidence(root));
  process.stdout.write(renderReleaseReadiness(report));
  process.exitCode = report.status === 'offline-ready' ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
