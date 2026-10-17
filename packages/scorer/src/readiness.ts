import {
  readinessScoreSchema,
  type ReadinessComponent,
  type ReadinessScore,
} from '../../shared/src/readiness.js';
import type { RuleEvaluation, VariantMatch } from '../../shared/src/diagnostics.js';

export type AdminContentEvidence = {
  title: string;
  descriptionHtml: string;
  seoTitle: string | null;
  seoDescription: string | null;
  productUpdatedAt: string;
  latestInventoryUpdatedAt: string;
};

export type StructuredDataEvidence = {
  sourceOutcome: 'observed' | 'inconclusive';
  presence: 'present' | 'absent' | 'unknown';
  malformedBlockCount: number;
  variantOfferCount: number;
  supportedAvailabilityCount: number;
};

export type ReadinessInput = {
  evaluations: RuleEvaluation[];
  matches: VariantMatch[];
  structuredData: StructuredDataEvidence;
  adminContent: AdminContentEvidence | null;
};

export type TransientClaim = {
  code: 'in_stock_now' | 'exact_quantity' | 'unsupported_restock' | 'unsupported_delivery';
};

const claimPatterns: Array<{ code: TransientClaim['code']; pattern: RegExp }> = [
  { code: 'in_stock_now', pattern: /\bin[\s-]+stock[\s-]+(?:right[\s-]+)?now\b/iu },
  { code: 'exact_quantity', pattern: /\b(?:(?:only|just)\s+\d{1,4}|\d{1,4}\s+(?:items?|units?))\s+(?:left|remaining|in[\s-]+stock)\b/iu },
  { code: 'unsupported_restock', pattern: /\b(?:restocks?|back[\s-]+in[\s-]+stock)\s+(?:on|by|within)\b/iu },
  { code: 'unsupported_delivery', pattern: /\b(?:ships?|delivers?|arrives?)\s+(?:today|tomorrow|by|within)\b/iu },
];

function plainText(value: string): string {
  return value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/giu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function detectTransientClaims(content: AdminContentEvidence): TransientClaim[] {
  const text = [content.title, plainText(content.descriptionHtml), content.seoTitle, content.seoDescription]
    .filter((value): value is string => value !== null)
    .join(' ');
  return claimPatterns
    .filter(candidate => candidate.pattern.test(text))
    .map(candidate => ({ code: candidate.code }));
}

function component(
  id: ReadinessComponent['id'],
  weight: ReadinessComponent['weight'],
  outcome: ReadinessComponent['outcome'],
  reasonCodes: string[],
  evidenceRefs: ReadinessComponent['evidenceRefs'],
): ReadinessComponent {
  return {
    id, weight, outcome,
    points: outcome === 'inconclusive' ? null : outcome === 'ready' ? weight : 0,
    reasonCodes,
    evidenceRefs,
  };
}

function availabilityAgreement(evaluations: RuleEvaluation[]): ReadinessComponent {
  const refs = evaluations.map(value => ({ source: 'detector' as const, field: value.ruleId }));
  if (evaluations.length === 0 || evaluations.some(value => value.result === 'inconclusive')) {
    return component('availability_agreement', 30, 'inconclusive', ['rule_evidence_inconclusive'], refs);
  }
  if (evaluations.some(value => value.result === 'fail')) {
    return component('availability_agreement', 30, 'not_ready', ['availability_contradiction'], refs);
  }
  return component('availability_agreement', 30, 'ready', ['availability_rules_agree'], refs);
}

function variantIdentity(matches: VariantMatch[]): ReadinessComponent {
  const refs = [{ source: 'detector' as const, field: 'variant_match' }];
  if (matches.length === 0 || matches.some(match => match.outcome === 'inconclusive')) {
    const reasons = matches.flatMap(match => match.outcome === 'inconclusive' ? [match.reasonCode] : []);
    return component('variant_identity', 25, 'inconclusive', reasons.length ? reasons : ['variant_identity_missing'], refs);
  }
  return component('variant_identity', 25, 'ready', ['variant_identity_exact'], refs);
}

function structuredDataQuality(data: StructuredDataEvidence): ReadinessComponent {
  const refs = [{ source: 'jsonld' as const, field: 'claims' }];
  if (data.sourceOutcome !== 'observed' || data.presence === 'unknown') {
    return component('structured_data_quality', 20, 'inconclusive', ['jsonld_source_inconclusive'], refs);
  }
  if (data.presence === 'absent') {
    return component('structured_data_quality', 20, 'not_ready', ['jsonld_absent'], refs);
  }
  if (data.malformedBlockCount > 0) {
    return component('structured_data_quality', 20, 'not_ready', ['jsonld_malformed'], refs);
  }
  if (data.variantOfferCount === 0 || data.supportedAvailabilityCount !== data.variantOfferCount) {
    return component('structured_data_quality', 20, 'not_ready', ['variant_offer_incomplete'], refs);
  }
  return component('structured_data_quality', 20, 'ready', ['variant_offers_complete'], refs);
}

export function scoreInventoryPromiseClarity(content: AdminContentEvidence | null): ReadinessComponent {
  const refs = [{ source: 'admin' as const, field: 'product_content' }];
  if (content === null) {
    return component('inventory_promise_clarity', 15, 'inconclusive', ['admin_content_unavailable'], refs);
  }
  const claims = detectTransientClaims(content);
  if (claims.length > 0) {
    return component('inventory_promise_clarity', 15, 'not_ready', claims.map(claim => claim.code), refs);
  }
  return component('inventory_promise_clarity', 15, 'ready', ['no_transient_inventory_promises'], refs);
}

export function scoreStaleClaimSafety(content: AdminContentEvidence | null): ReadinessComponent {
  const refs = [
    { source: 'admin' as const, field: 'product.updatedAt' },
    { source: 'admin' as const, field: 'inventoryItem.updatedAt' },
  ];
  if (content === null) {
    return component('stale_claim_safety', 10, 'inconclusive', ['admin_content_unavailable'], refs);
  }
  const productTime = Date.parse(content.productUpdatedAt);
  const inventoryTime = Date.parse(content.latestInventoryUpdatedAt);
  if (!Number.isFinite(productTime) || !Number.isFinite(inventoryTime)) {
    return component('stale_claim_safety', 10, 'inconclusive', ['freshness_timestamp_invalid'], refs);
  }
  const claims = detectTransientClaims(content);
  if (claims.length > 0 && productTime < inventoryTime) {
    return component('stale_claim_safety', 10, 'not_ready', ['content_predates_inventory_change'], refs);
  }
  return component('stale_claim_safety', 10, 'ready', [
    claims.length === 0 ? 'no_stale_sensitive_claims' : 'claim_content_not_older_than_inventory',
  ], refs);
}

export function scoreInventorySearchReadiness(input: ReadinessInput): ReadinessScore {
  const components = [
    availabilityAgreement(input.evaluations),
    variantIdentity(input.matches),
    structuredDataQuality(input.structuredData),
    scoreInventoryPromiseClarity(input.adminContent),
    scoreStaleClaimSafety(input.adminContent),
  ];
  const conclusive = components.filter(value => value.points !== null);
  const knownPoints = conclusive.reduce((total, value) => total + value.points!, 0);
  const knownMax = conclusive.reduce((total, value) => total + value.weight, 0);
  return readinessScoreSchema.parse({
    schemaVersion: 1,
    total: conclusive.length === components.length ? knownPoints : null,
    knownPoints,
    knownMax,
    components,
    limitation: 'Diagnostic inventory-search readiness; not an SEO ranking claim.',
  });
}
