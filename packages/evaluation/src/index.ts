import { z } from 'zod';
import {
  adminAvailabilitySchema,
  type AdminAvailability,
  type BrowserVariantObservation,
  type RuleEvaluation,
  type RuleId,
  type RuleResult,
  type VariantMatch,
} from '../../shared/src/diagnostics.js';
import { evaluateST001, evaluateST002, evaluateST003 } from '../../detector/src/rules.js';

const ruleIds = ['ST-001', 'ST-002', 'ST-003'] as const;
const productId = 'gid://shopify/Product/6000';
const variantId = 'gid://shopify/ProductVariant/6001';
const legacyVariantId = '6001';

const availabilityReasonSchema = z.enum([
  'admin_evidence_unavailable', 'product_not_active', 'not_published',
  'continue_selling', 'inventory_untracked', 'sellable_quantity_positive',
  'sellable_quantity_nonpositive',
]);
const groundTruthSchema = z.enum(['positive', 'negative', 'inconclusive', 'not_applicable']);
const matchFixtureSchema = z.enum(['exact', 'ambiguous', 'mismatch']);
const jsonLdFixtureSchema = z.object({
  sourceOutcome: z.enum(['observed', 'inconclusive']),
  match: matchFixtureSchema,
  claimKind: z.enum(['Offer', 'Product', 'ProductGroup', 'AggregateOffer']).nullable(),
  availabilityCanonical: z.string().nullable(),
  coherentClaimCount: z.number().int().nonnegative(),
});
const browserFixtureSchema = z.object({
  sourceOutcome: z.enum(['observed', 'inconclusive']),
  match: matchFixtureSchema,
  controlState: z.enum(['enabled', 'disabled', 'missing', 'ambiguous']),
  storefrontPurchasable: z.boolean().nullable(),
});
const ruleCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  ruleId: z.enum(ruleIds),
  groundTruth: groundTruthSchema,
  expectedResult: z.enum(['pass', 'fail', 'inconclusive', 'not_applicable']),
  availability: z.object({
    state: z.enum(['purchasable', 'unavailable', 'inconclusive']),
    reasonCode: availabilityReasonSchema,
  }),
  jsonLd: jsonLdFixtureSchema.optional(),
  browser: browserFixtureSchema.optional(),
}).superRefine((value, context) => {
  if (value.ruleId === 'ST-001' && value.jsonLd === undefined) {
    context.addIssue({ code: 'custom', message: 'ST-001 requires JSON-LD evidence.' });
  }
  if (value.ruleId !== 'ST-001' && value.browser === undefined) {
    context.addIssue({ code: 'custom', message: `${value.ruleId} requires browser evidence.` });
  }
});

export const ruleCorpusSchema = z.object({
  schemaVersion: z.literal(1),
  description: z.string().min(1),
  evidenceRunId: z.string().uuid(),
  evaluatedAt: z.string().datetime({ offset: true }),
  cases: z.array(ruleCaseSchema).min(20),
}).superRefine((value, context) => {
  if (new Set(value.cases.map(testCase => testCase.id)).size !== value.cases.length) {
    context.addIssue({ code: 'custom', message: 'Evaluation case IDs must be unique.' });
  }
  for (const ruleId of ruleIds) {
    if (!value.cases.some(testCase => testCase.ruleId === ruleId)) {
      context.addIssue({ code: 'custom', message: `Evaluation corpus must include ${ruleId}.` });
    }
  }
});

export type RuleCorpus = z.infer<typeof ruleCorpusSchema>;
export type RuleCase = RuleCorpus['cases'][number];
export type GroundTruth = z.infer<typeof groundTruthSchema>;

export type ConfusionCounts = {
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
  inconclusive: number;
  notApplicable: number;
};

export type RuleMetrics = ConfusionCounts & {
  ruleId: RuleId | 'all';
  caseCount: number;
  precision: number | null;
};

export type RuleEvaluationReport = {
  schemaVersion: 1;
  corpus: {
    description: string;
    evidenceRunId: string;
    evaluatedAt: string;
    caseCount: number;
  };
  aggregate: RuleMetrics;
  byRule: RuleMetrics[];
  cases: Array<{
    id: string;
    ruleId: RuleId;
    groundTruth: GroundTruth;
    expectedResult: RuleResult;
    actualResult: RuleResult;
    reasonCode: string;
    matchesExpected: boolean;
  }>;
};

function evidenceForAvailability(reasonCode: RuleCase['availability']['reasonCode']): AdminAvailability['evidence'] {
  const base: AdminAvailability['evidence'] = {
    productStatus: 'ACTIVE', publishedToOnlineStore: true, inventoryTracked: true,
    inventoryPolicy: 'DENY', sellableOnlineQuantity: 0, inventoryQuantity: 0,
  };
  if (reasonCode === 'admin_evidence_unavailable') return {
    productStatus: null, publishedToOnlineStore: null, inventoryTracked: null,
    inventoryPolicy: null, sellableOnlineQuantity: null, inventoryQuantity: null,
  };
  if (reasonCode === 'product_not_active') return { ...base, productStatus: 'DRAFT' };
  if (reasonCode === 'not_published') return { ...base, publishedToOnlineStore: false };
  if (reasonCode === 'continue_selling') return { ...base, inventoryPolicy: 'CONTINUE' };
  if (reasonCode === 'inventory_untracked') return {
    ...base, inventoryTracked: false, inventoryQuantity: null,
  };
  if (reasonCode === 'sellable_quantity_positive') return {
    ...base, sellableOnlineQuantity: 5, inventoryQuantity: 5,
  };
  return base;
}

function availabilityFor(testCase: RuleCase): AdminAvailability {
  return adminAvailabilitySchema.parse({
    productId, variantId, legacyVariantId,
    state: testCase.availability.state,
    reasonCode: testCase.availability.reasonCode,
    evidence: evidenceForAvailability(testCase.availability.reasonCode),
  });
}

function matchFor(kind: z.infer<typeof matchFixtureSchema>): VariantMatch {
  if (kind === 'exact') return {
    outcome: 'matched', variantId, legacyVariantId, method: 'variant_id',
    confidence: 'authoritative', corroboratingMethods: ['variant_id'],
  };
  return {
    outcome: 'inconclusive',
    reasonCode: kind === 'ambiguous' ? 'ambiguous_options' : 'conflicting_source_claims',
    candidateCount: 2,
  };
}

function browserFor(testCase: RuleCase): { observation: BrowserVariantObservation; match: VariantMatch } {
  const fixture = testCase.browser;
  if (fixture === undefined) throw new Error(`${testCase.id} is missing browser evidence.`);
  const observed = fixture.sourceOutcome === 'observed';
  return {
    observation: {
      requestedVariantId: variantId,
      requestedLegacyVariantId: legacyVariantId,
      outcome: fixture.sourceOutcome,
      reasonCode: observed ? null : 'synthetic_inconclusive',
      selectedLegacyVariantId: fixture.match === 'mismatch' ? '6002' : legacyVariantId,
      controlState: fixture.controlState,
      cartOutcome: 'not_attempted',
      storefrontPurchasable: fixture.storefrontPurchasable,
    },
    match: matchFor(fixture.match),
  };
}

function evaluateCase(testCase: RuleCase, corpus: RuleCorpus): RuleEvaluation {
  const context = {
    availability: availabilityFor(testCase),
    evidenceRunId: corpus.evidenceRunId,
    evaluatedAt: corpus.evaluatedAt,
  };
  if (testCase.ruleId === 'ST-001') {
    const fixture = testCase.jsonLd;
    if (fixture === undefined) throw new Error(`${testCase.id} is missing JSON-LD evidence.`);
    return evaluateST001(context, {
      sourceOutcome: fixture.sourceOutcome,
      match: matchFor(fixture.match),
      claimKind: fixture.claimKind,
      availabilityCanonical: fixture.availabilityCanonical,
      coherentClaimCount: fixture.coherentClaimCount,
    });
  }
  const browser = browserFor(testCase);
  return testCase.ruleId === 'ST-002'
    ? evaluateST002(context, browser.observation, browser.match)
    : evaluateST003(context, browser.observation, browser.match);
}

function emptyCounts(): ConfusionCounts {
  return {
    truePositive: 0, falsePositive: 0, trueNegative: 0, falseNegative: 0,
    inconclusive: 0, notApplicable: 0,
  };
}

function addOutcome(counts: ConfusionCounts, truth: GroundTruth, actual: RuleResult): void {
  if (truth === 'inconclusive' || actual === 'inconclusive') {
    counts.inconclusive += 1;
  } else if (truth === 'not_applicable' || actual === 'not_applicable') {
    counts.notApplicable += 1;
  } else if (truth === 'positive') {
    counts[actual === 'fail' ? 'truePositive' : 'falseNegative'] += 1;
  } else {
    counts[actual === 'fail' ? 'falsePositive' : 'trueNegative'] += 1;
  }
}

function metrics(ruleId: RuleId | 'all', cases: RuleEvaluationReport['cases']): RuleMetrics {
  const counts = emptyCounts();
  for (const result of cases) addOutcome(counts, result.groundTruth, result.actualResult);
  const predictedPositive = counts.truePositive + counts.falsePositive;
  return {
    ruleId, caseCount: cases.length, ...counts,
    precision: predictedPositive === 0 ? null : counts.truePositive / predictedPositive,
  };
}

export function evaluateRuleCorpus(input: unknown): RuleEvaluationReport {
  const corpus = ruleCorpusSchema.parse(input);
  const cases = corpus.cases.map(testCase => {
    const actual = evaluateCase(testCase, corpus);
    return {
      id: testCase.id,
      ruleId: testCase.ruleId,
      groundTruth: testCase.groundTruth,
      expectedResult: testCase.expectedResult,
      actualResult: actual.result,
      reasonCode: actual.reasonCode,
      matchesExpected: actual.result === testCase.expectedResult,
    };
  });
  return {
    schemaVersion: 1,
    corpus: {
      description: corpus.description,
      evidenceRunId: corpus.evidenceRunId,
      evaluatedAt: corpus.evaluatedAt,
      caseCount: cases.length,
    },
    aggregate: metrics('all', cases),
    byRule: ruleIds.map(ruleId => metrics(ruleId, cases.filter(result => result.ruleId === ruleId))),
    cases,
  };
}

export function renderEvaluationReport(report: RuleEvaluationReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
