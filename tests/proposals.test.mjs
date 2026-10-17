import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyReconciliation,
  snapshotFromAdmin,
} from '../dist/packages/agent/src/proposals.js';
import {
  CONTENT_LIMITS,
  containsTransientClaim,
  createFieldDiffs,
  createImprovementProposal,
  createRevertProposal,
  contentFingerprint,
  hashValue,
  isStandaloneTransientClaim,
  parseConservativeDescription,
  validateProposal,
} from '../dist/packages/proposals/src/index.js';
import { scoreInventorySearchReadiness } from '../dist/packages/scorer/src/readiness.js';

const productId = 'gid://shopify/Product/9000';
const variantId = 'gid://shopify/ProductVariant/9001';
const runId = '11111111-1111-4111-8111-111111111111';
const proposalId = '22222222-2222-4222-8222-222222222222';

function readiness(content) {
  return scoreInventorySearchReadiness({
    evaluations: [{
      schemaVersion: 1, ruleVersion: 1, ruleId: 'ST-001', productId, variantId,
      result: 'pass', severity: 'medium', reasonCode: 'synthetic_pass', match: null,
      requiredSources: ['admin', 'jsonld'], evidenceRunId: runId,
      evaluatedAt: '2026-10-17T12:00:02.000Z',
    }],
    matches: [{
      outcome: 'matched', variantId, legacyVariantId: '9001', method: 'variant_id',
      confidence: 'authoritative', corroboratingMethods: ['variant_id'],
    }],
    structuredData: {
      sourceOutcome: 'observed', presence: 'present', malformedBlockCount: 0,
      variantOfferCount: 1, supportedAvailabilityCount: 1,
    },
    adminContent: {
      title: content.title, descriptionHtml: content.descriptionHtml,
      seoTitle: content.seo.title, seoDescription: content.seo.description,
      productUpdatedAt: '2026-10-17T10:00:00.000Z',
      latestInventoryUpdatedAt: '2026-10-17T11:00:00.000Z',
    },
  });
}

function snapshot(content) {
  return {
    productId, productUpdatedAt: '2026-10-17T10:00:00.000Z',
    latestInventoryUpdatedAt: '2026-10-17T11:00:00.000Z',
    observedAt: '2026-10-17T12:00:00.000Z', evidenceRunId: runId,
    content, fingerprint: contentFingerprint(productId, '2026-10-17T10:00:00.000Z', content),
  };
}

test('creates one extractive proposal across safe fields and predicts only content-score gains', () => {
  const content = {
    title: 'Trail Shoe | Only 3 left',
    descriptionHtml: '<p>Durable trail shoe.</p><p>Ships tomorrow.</p>',
    seo: { title: null, description: null },
  };
  const current = readiness(content);
  assert.equal(current.total, 75);
  const result = createImprovementProposal({
    id: proposalId, createdAt: '2026-10-17T12:01:00.000Z', snapshot: snapshot(content),
    currentReadiness: current,
  });
  assert.ok(result.proposal);
  assert.equal(result.proposal.candidate.title, 'Trail Shoe');
  assert.equal(result.proposal.candidate.descriptionHtml, '<p>Durable trail shoe.</p>');
  assert.equal(result.proposal.candidate.seo.title, 'Trail Shoe');
  assert.equal(result.proposal.candidate.seo.description, 'Durable trail shoe.');
  assert.equal(result.proposal.predictedReadiness.total, 100);
  assert.deepEqual(result.proposal.changes.map(change => change.field).sort(), [
    'descriptionHtml', 'seo.description', 'seo.title', 'title',
  ]);
  assert.ok(createFieldDiffs(result.proposal.changes).every(diff => diff.parts.some(part => part.kind !== 'equal')));
});

test('mixed claims and unsupported HTML stay guidance-only', () => {
  const mixed = {
    title: 'Waterproof trail shoe, only 3 left',
    descriptionHtml: '<p><strong>Durable</strong> and ships tomorrow.</p>',
    seo: { title: null, description: null },
  };
  const result = createImprovementProposal({
    id: proposalId, createdAt: '2026-10-17T12:01:00.000Z', snapshot: snapshot(mixed),
    currentReadiness: readiness(mixed),
  });
  assert.equal(result.proposal, null);
  assert.ok(result.guidanceCodes.includes('PV_UNSAFE_MIXED_CLAIM'));
  assert.ok(result.guidanceCodes.includes('PV_TRANSIENT_CLAIM_REMAINS'));
  assert.deepEqual(parseConservativeDescription('<script>x</script>'), { ok: false, reason: 'active' });
  assert.equal(containsTransientClaim('Designed for stocked shelves.'), false);
  assert.equal(isStandaloneTransientClaim('12 units remaining.'), true);
});

test('validators reject invented copies, empty output, limits, and information loss', () => {
  const content = { title: 'Trail Shoe', descriptionHtml: '<p>Durable.</p>', seo: { title: null, description: null } };
  const current = readiness(content);
  const candidate = structuredClone(content);
  candidate.seo.title = 'Invented waterproof claim';
  const change = {
    field: 'seo.title', before: null, after: candidate.seo.title,
    beforeHash: '0'.repeat(64), afterHash: '1'.repeat(64),
    ruleCodes: ['ST-G002_COPY_TITLE_TO_EMPTY_SEO_TITLE'],
    provenance: [{ sourceField: 'title', operation: 'copy', start: 0, end: content.title.length }],
  };
  const result = validateProposal('improvement', snapshot(content), candidate, [change], current, current);
  assert.equal(result.valid, false);
  assert.ok(result.reasonCodes.includes('PV_ARTIFACT_HASH_MISMATCH'));
  assert.ok(result.reasonCodes.includes('PV_UNATTRIBUTED_INSERTION'));

  const oversized = { ...candidate, title: 'x'.repeat(CONTENT_LIMITS.title + 1) };
  const length = validateProposal('improvement', snapshot(content), oversized, [change], current, current);
  assert.ok(length.reasonCodes.includes('PV_TITLE_TOO_LONG'));
});

test('validator reason codes cover structural, evidence, HTML, loss, and score failures', () => {
  const content = { title: 'Trail Shoe', descriptionHtml: '<p>Durable.</p>', seo: { title: null, description: null } };
  const current = readiness(content);
  const invalidBase = { ...snapshot(content), fingerprint: 'f'.repeat(64) };
  const candidate = structuredClone(content);
  candidate.descriptionHtml = '<p>Only 3 left | Durable.</p';
  const change = {
    field: 'descriptionHtml', before: content.descriptionHtml, after: candidate.descriptionHtml,
    beforeHash: hashValue(content.descriptionHtml), afterHash: hashValue(candidate.descriptionHtml),
    ruleCodes: ['ST-G001_REMOVE_TRANSIENT_CLAIM'],
    provenance: [{ sourceField: 'descriptionHtml', operation: 'delete_transient_claim', start: 3, end: 10 }],
  };
  const lower = { ...current, total: 75, knownPoints: 75,
    components: current.components.map(component => component.id === 'inventory_promise_clarity'
      ? { ...component, outcome: 'not_ready', points: 0, reasonCodes: ['synthetic'] } : component) };
  const result = validateProposal('improvement', invalidBase, candidate, [change, { ...change }, { ...change, field: 'unknown.field' }], current, lower);
  for (const code of [
    'PV_UNAPPROVED_FIELD', 'PV_DUPLICATE_FIELD', 'PV_BASE_EVIDENCE_INVALID',
    'PV_INFORMATION_LOSS', 'PV_UNAUTHORIZED_REORDER', 'PV_UNBALANCED_HTML',
    'PV_TRANSIENT_CLAIM_REMAINS', 'PV_READINESS_REGRESSION',
  ]) assert.ok(result.reasonCodes.includes(code), code);

  const emptyCandidate = structuredClone(content);
  emptyCandidate.seo.title = '';
  const empty = validateProposal('improvement', snapshot(content), emptyCandidate, [{
    field: 'seo.title', before: null, after: '', beforeHash: hashValue(null), afterHash: hashValue(''),
    ruleCodes: ['ST-G002_COPY_TITLE_TO_EMPTY_SEO_TITLE'], provenance: [],
  }], current, current);
  assert.ok(empty.reasonCodes.includes('PV_EMPTY_CHANGED_FIELD'));
  assert.ok(empty.reasonCodes.includes('PV_SOURCE_ATTRIBUTION_MISSING'));
});

test('snapshots are byte-exact and reconciliation distinguishes applied, base, and mixed states', () => {
  const admin = {
    schemaVersion: 1, mode: 'admin_only', source: 'shopify_admin_graphql', productId,
    observationWindow: { startedAt: '2026-10-17T12:00:00.000Z', completedAt: '2026-10-17T12:00:01.000Z' },
    apiVersion: { requested: '2026-10', response: '2026-10' }, pageCount: 1, complete: true,
    limitations: ['Synthetic fixture.'],
    product: {
      id: productId, title: 'Trail Shoe', descriptionHtml: '<p>Durable.</p>',
      seo: { title: null, description: null }, status: 'ACTIVE', onlineStoreUrl: null,
      updatedAt: '2026-10-17T10:00:00.000Z', variants: [{
        id: variantId, legacyResourceId: '9001', selectedOptions: [], inventoryPolicy: 'DENY',
        inventoryQuantity: 1, sellableOnlineQuantity: 1, updatedAt: '2026-10-17T11:00:00.000Z',
        inventoryItem: { id: 'gid://shopify/InventoryItem/9002', tracked: true, updatedAt: '2026-10-17T11:00:00.000Z' },
      }],
    },
  };
  const base = snapshotFromAdmin(admin, runId);
  const proposal = {
    candidate: { ...base.content, seo: { ...base.content.seo, title: 'Trail Shoe' } },
    base,
  };
  assert.equal(classifyReconciliation(proposal, base), 'base');
  assert.equal(classifyReconciliation(proposal, { ...base, content: proposal.candidate, productUpdatedAt: '2026-10-17T12:02:00.000Z' }), 'candidate');
  assert.equal(classifyReconciliation(proposal, { ...base, content: { ...base.content, title: 'Third party title' }, productUpdatedAt: '2026-10-17T12:02:00.000Z' }), 'ambiguous');
});

test('revert is a separate warned proposal that restores only parent-touched fields', () => {
  const original = {
    title: 'Trail Shoe | Only 3 left', descriptionHtml: '<p>Durable.</p><p>Ships tomorrow.</p>',
    seo: { title: null, description: null },
  };
  const improvement = createImprovementProposal({
    id: proposalId, createdAt: '2026-10-17T12:01:00.000Z', snapshot: snapshot(original),
    currentReadiness: readiness(original),
  }).proposal;
  assert.ok(improvement);
  const after = snapshot(improvement.candidate);
  after.evidenceRunId = '33333333-3333-4333-8333-333333333333';
  after.productUpdatedAt = '2026-10-17T12:02:00.000Z';
  after.fingerprint = contentFingerprint(productId, after.productUpdatedAt, after.content);
  const revert = createRevertProposal({
    id: '44444444-4444-4444-8444-444444444444', createdAt: '2026-10-17T12:03:00.000Z',
    parent: improvement, base: after, currentReadiness: readiness(improvement.candidate),
  });
  assert.equal(revert.kind, 'revert');
  assert.equal(revert.parentProposalId, improvement.id);
  assert.deepEqual(revert.candidate, original);
  assert.equal(revert.validation.valid, true, JSON.stringify({ validation: revert.validation, changes: revert.changes, base: revert.base.content, candidate: revert.candidate }));
  assert.ok(revert.validation.warningCodes.includes('PW_TRANSIENT_CLAIM_REINTRODUCED'));
  assert.ok(revert.validation.warningCodes.includes('PW_READINESS_REGRESSION'));
});
