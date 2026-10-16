import type { StoredTestRunResult } from '../../../packages/test-runner/src/index.js';

export function formatStoredTestRun(result: StoredTestRunResult): string[] {
  if (result.summary === null) return ['No active regression tests.'];
  const lines = result.executions.map((execution, index) =>
    `${execution.outcome.toUpperCase()} ${execution.ruleId} test ${index + 1}${
      execution.outcome === 'inconclusive' ? ` (${execution.reasonCode})` : ''
    }`,
  );
  lines.push(
    `Tests: ${result.summary.passed} passed; ${result.summary.failed} failed; ${result.summary.inconclusive} inconclusive.`,
  );
  return lines;
}
