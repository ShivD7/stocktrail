import { z } from 'zod';
import {
  contentFingerprint,
  hashValue,
  validateProposal,
} from '../../proposals/src/index.js';
import type {
  ProductContent,
  ProposalFieldChange,
  ProposalSnapshot,
  ProposalValidationCode,
} from '../../shared/src/proposals.js';
import type { ReadinessScore } from '../../shared/src/readiness.js';

const attackSchema = z.enum([
  'invented_fact', 'active_content', 'unbalanced_html', 'unsafe_html_shape',
  'transient_claim', 'empty_title', 'oversized_title', 'missing_attribution',
  'information_loss', 'readiness_regression', 'artifact_hash',
  'unapproved_field', 'duplicate_field',
]);

export const unsafeProposalCorpusSchema = z.object({
  schemaVersion: z.literal(1),
  description: z.string().min(1),
  cases: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    attack: attackSchema,
    expectedAccepted: z.literal(false),
    expectedReasonCode: z.string().regex(/^PV_[A-Z_]+$/),
  })).min(10),
}).superRefine((value, context) => {
  if (new Set(value.cases.map(testCase => testCase.id)).size !== value.cases.length) {
    context.addIssue({ code: 'custom', message: 'Unsafe proposal case IDs must be unique.' });
  }
});

type UnsafeProposalCorpus = z.infer<typeof unsafeProposalCorpusSchema>;
type Attack = z.infer<typeof attackSchema>;

export type UnsafeProposalReport = {
  schemaVersion: 1;
  description: string;
  evaluated: number;
  accepted: number;
  rejected: number;
  unsafeProposalAcceptanceRate: number;
  cases: Array<{
    id: string;
    attack: Attack;
    accepted: boolean;
    reasonCodes: ProposalValidationCode[];
    matchesExpected: boolean;
  }>;
};

const productId = 'gid://shopify/Product/6100';
const baseContent: ProductContent = {
  title: 'Synthetic Trail Shoe',
  descriptionHtml: '<p>Durable synthetic trail shoe.</p>',
  seo: { title: null, description: 'Durable synthetic trail shoe.' },
};

function readiness(): ReadinessScore {
  const values = [
    ['availability_agreement', 30], ['variant_identity', 25],
    ['structured_data_quality', 20], ['inventory_promise_clarity', 15],
    ['stale_claim_safety', 10],
  ] as const;
  return {
    schemaVersion: 1, total: 100, knownPoints: 100, knownMax: 100,
    components: values.map(([id, weight]) => ({
      id, weight, outcome: 'ready' as const, points: weight,
      reasonCodes: ['synthetic_evaluation'],
      evidenceRefs: [{ source: 'detector' as const, field: 'synthetic_evaluation' }],
    })),
    limitation: 'Diagnostic inventory-search readiness; not an SEO ranking claim.',
  };
}

function snapshot(): ProposalSnapshot {
  return {
    productId,
    productUpdatedAt: '2026-11-13T10:00:00.000Z',
    latestInventoryUpdatedAt: '2026-11-13T11:00:00.000Z',
    observedAt: '2026-11-13T12:00:00.000Z',
    evidenceRunId: '61000000-0000-4000-8000-000000000001',
    content: structuredClone(baseContent),
    fingerprint: contentFingerprint(productId, '2026-11-13T10:00:00.000Z', baseContent),
  };
}

function copyTitleChange(candidate: ProductContent): ProposalFieldChange {
  return {
    field: 'seo.title', before: null, after: candidate.seo.title,
    beforeHash: hashValue(null), afterHash: hashValue(candidate.seo.title),
    ruleCodes: ['ST-G002_COPY_TITLE_TO_EMPTY_SEO_TITLE'],
    provenance: [{ sourceField: 'title', operation: 'copy', start: 0, end: baseContent.title.length }],
  };
}

function descriptionChange(candidate: ProductContent): ProposalFieldChange {
  return {
    field: 'descriptionHtml', before: baseContent.descriptionHtml,
    after: candidate.descriptionHtml,
    beforeHash: hashValue(baseContent.descriptionHtml),
    afterHash: hashValue(candidate.descriptionHtml),
    ruleCodes: ['ST-G001_REMOVE_TRANSIENT_CLAIM'],
    provenance: [{
      sourceField: 'descriptionHtml', operation: 'copy', start: 0,
      end: baseContent.descriptionHtml.length,
    }],
  };
}

function adversarialProposal(attack: Attack): {
  candidate: ProductContent;
  changes: ProposalFieldChange[];
  predicted: ReadinessScore;
} {
  const candidate = structuredClone(baseContent);
  candidate.seo.title = candidate.title;
  let changes = [copyTitleChange(candidate)];
  let predicted = readiness();

  if (attack === 'invented_fact') {
    candidate.seo.title = 'Synthetic Waterproof Trail Shoe';
    changes = [copyTitleChange(candidate)];
  } else if (attack === 'active_content') {
    candidate.descriptionHtml = '<script>alert(1)</script>';
    changes = [descriptionChange(candidate)];
  } else if (attack === 'unbalanced_html') {
    candidate.descriptionHtml = '<p>Durable synthetic trail shoe.';
    changes = [descriptionChange(candidate)];
  } else if (attack === 'unsafe_html_shape') {
    candidate.descriptionHtml = '<p><strong>Durable</strong> synthetic trail shoe.</p>';
    changes = [descriptionChange(candidate)];
  } else if (attack === 'transient_claim') {
    candidate.seo.title = 'Only 2 left';
    changes = [copyTitleChange(candidate)];
  } else if (attack === 'empty_title') {
    candidate.title = '';
    changes = [{
      field: 'title', before: baseContent.title, after: '',
      beforeHash: hashValue(baseContent.title), afterHash: hashValue(''),
      ruleCodes: ['ST-G001_REMOVE_TRANSIENT_CLAIM'],
      provenance: [{ sourceField: 'title', operation: 'delete_transient_claim', start: 0, end: baseContent.title.length }],
    }];
  } else if (attack === 'oversized_title') {
    candidate.title = 'x'.repeat(256);
    changes = [{
      field: 'title', before: baseContent.title, after: candidate.title,
      beforeHash: hashValue(baseContent.title), afterHash: hashValue(candidate.title),
      ruleCodes: ['ST-G001_REMOVE_TRANSIENT_CLAIM'],
      provenance: [{ sourceField: 'title', operation: 'copy', start: 0, end: baseContent.title.length }],
    }];
  } else if (attack === 'missing_attribution') {
    changes = [{ ...copyTitleChange(candidate), provenance: [] }];
  } else if (attack === 'information_loss') {
    candidate.descriptionHtml = '<p>Synthetic trail shoe.</p>';
    changes = [{
      field: 'descriptionHtml', before: baseContent.descriptionHtml, after: candidate.descriptionHtml,
      beforeHash: hashValue(baseContent.descriptionHtml), afterHash: hashValue(candidate.descriptionHtml),
      ruleCodes: ['ST-G001_REMOVE_TRANSIENT_CLAIM'],
      provenance: [{ sourceField: 'descriptionHtml', operation: 'delete_transient_claim', start: 3, end: 11 }],
    }];
  } else if (attack === 'readiness_regression') {
    predicted = readiness();
    predicted.components = predicted.components.map(component => component.id === 'stale_claim_safety'
      ? { ...component, outcome: 'not_ready' as const, points: 0 } : component);
    predicted.total = 90;
    predicted.knownPoints = 90;
  } else if (attack === 'artifact_hash') {
    changes = [{ ...copyTitleChange(candidate), beforeHash: '0'.repeat(64) }];
  } else if (attack === 'unapproved_field') {
    changes = [{
      ...copyTitleChange(candidate),
      field: 'tags' as ProposalFieldChange['field'],
      before: baseContent.seo.description,
      after: baseContent.seo.description,
      beforeHash: hashValue(baseContent.seo.description),
      afterHash: hashValue(baseContent.seo.description),
    }];
  } else if (attack === 'duplicate_field') {
    changes = [copyTitleChange(candidate), copyTitleChange(candidate)];
  }
  return { candidate, changes, predicted };
}

export function evaluateUnsafeProposalCorpus(input: unknown): UnsafeProposalReport {
  const corpus: UnsafeProposalCorpus = unsafeProposalCorpusSchema.parse(input);
  const current = readiness();
  const base = snapshot();
  const cases = corpus.cases.map(testCase => {
    const proposal = adversarialProposal(testCase.attack);
    const validation = validateProposal(
      'improvement', base, proposal.candidate, proposal.changes, current, proposal.predicted,
    );
    const accepted = validation.valid;
    return {
      id: testCase.id,
      attack: testCase.attack,
      accepted,
      reasonCodes: validation.reasonCodes,
      matchesExpected: accepted === testCase.expectedAccepted &&
        validation.reasonCodes.includes(testCase.expectedReasonCode as ProposalValidationCode),
    };
  });
  const accepted = cases.filter(testCase => testCase.accepted).length;
  return {
    schemaVersion: 1,
    description: corpus.description,
    evaluated: cases.length,
    accepted,
    rejected: cases.length - accepted,
    unsafeProposalAcceptanceRate: cases.length === 0 ? 0 : accepted / cases.length,
    cases,
  };
}

export function renderUnsafeProposalReport(report: UnsafeProposalReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
