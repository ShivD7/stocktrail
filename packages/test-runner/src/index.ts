import {
  openCatalogRepository,
  type CatalogRepository,
  type RegressionTestRunSummary,
  type StoredRegressionTest,
} from '../../database/src/catalog-repository.js';
import type { RuleEvaluation } from '../../shared/src/diagnostics.js';

export type TestExecution = {
  testId: string;
  ruleId: StoredRegressionTest['assertion']['ruleId'];
  outcome: 'pass' | 'fail' | 'inconclusive';
  reasonCode: string;
  evidenceRunId: string | null;
};

export type StoredTestRunResult = {
  summary: RegressionTestRunSummary | null;
  executions: TestExecution[];
};

export type TestRunnerDependencies = {
  openRepository(directory: string): Promise<CatalogRepository>;
  collectProduct(
    productGid: string,
    tests: StoredRegressionTest[],
  ): Promise<{ evaluations: RuleEvaluation[]; evidenceRunId: string | null }>;
  now(): Date;
};

export function evaluateStoredAssertion(
  test: StoredRegressionTest,
  evaluations: RuleEvaluation[],
  evidenceRunId: string | null,
): TestExecution {
  const evaluation = evaluations.find(value =>
    value.ruleId === test.assertion.ruleId && value.variantId === test.assertion.variantId,
  );
  if (!evaluation) {
    return {
      testId: test.id, ruleId: test.assertion.ruleId, outcome: 'inconclusive',
      reasonCode: 'fresh_rule_evaluation_unavailable', evidenceRunId,
    };
  }
  const outcome = evaluation.result === 'fail' ? 'fail'
    : evaluation.result === 'inconclusive' ? 'inconclusive' : 'pass';
  return {
    testId: test.id,
    ruleId: test.assertion.ruleId,
    outcome,
    reasonCode: evaluation.reasonCode,
    evidenceRunId: evaluation.evidenceRunId,
  };
}

const defaultDependencies: TestRunnerDependencies = {
  openRepository: openCatalogRepository,
  async collectProduct() {
    // The live browser seam is intentionally not implemented until its runtime is approved.
    return { evaluations: [], evidenceRunId: null };
  },
  now: () => new Date(),
};

export async function runStoredRegressionTests(
  directory: string,
  dependencies: TestRunnerDependencies = defaultDependencies,
): Promise<StoredTestRunResult> {
  let repository = await dependencies.openRepository(directory);
  let tests: StoredRegressionTest[];
  try {
    tests = repository.listActiveRegressionTests();
  } finally {
    repository.close();
  }
  if (tests.length === 0) return { summary: null, executions: [] };

  const startedAt = dependencies.now().toISOString();
  const groups = new Map<string, StoredRegressionTest[]>();
  for (const test of tests) groups.set(test.productGid, [...(groups.get(test.productGid) ?? []), test]);
  const executions: TestExecution[] = [];
  for (const [productGid, productTests] of groups) {
    const collected = await dependencies.collectProduct(productGid, productTests);
    for (const test of productTests) {
      const execution = evaluateStoredAssertion(test, collected.evaluations, collected.evidenceRunId);
      if (execution.reasonCode === 'fresh_rule_evaluation_unavailable') {
        execution.reasonCode = 'browser_runtime_not_integrated';
      }
      executions.push(execution);
    }
  }
  const completedAt = dependencies.now().toISOString();
  repository = await dependencies.openRepository(directory);
  try {
    const summary = repository.recordRegressionTestRun(
      startedAt,
      completedAt,
      executions.map(value => ({
        testId: value.testId,
        outcome: value.outcome,
        reasonCode: value.reasonCode,
        evidenceRunId: value.evidenceRunId,
      })),
    );
    return { summary, executions };
  } finally {
    repository.close();
  }
}
