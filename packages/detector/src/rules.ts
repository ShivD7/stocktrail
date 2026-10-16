import {
  ruleEvaluationSchema,
  type AdminAvailability,
  type BrowserVariantObservation,
  type RuleEvaluation,
  type RuleId,
  type VariantMatch,
} from '../../shared/src/diagnostics.js';

type Context = {
  availability: AdminAvailability;
  evidenceRunId: string;
  evaluatedAt: string;
};

function evaluation(
  context: Context,
  ruleId: RuleId,
  result: RuleEvaluation['result'],
  severity: RuleEvaluation['severity'],
  reasonCode: string,
  requiredSources: RuleEvaluation['requiredSources'],
  match: VariantMatch | null,
): RuleEvaluation {
  return ruleEvaluationSchema.parse({
    schemaVersion: 1, ruleVersion: 1, ruleId,
    productId: context.availability.productId,
    variantId: context.availability.variantId,
    result, severity, reasonCode, match, requiredSources,
    evidenceRunId: context.evidenceRunId, evaluatedAt: context.evaluatedAt,
  });
}

export type JsonLdRuleInput = {
  sourceOutcome: 'observed' | 'inconclusive';
  match: VariantMatch | null;
  claimKind: 'Offer' | 'Product' | 'ProductGroup' | 'AggregateOffer' | null;
  availabilityCanonical: string | null;
  coherentClaimCount: number;
};

export function evaluateST001(context: Context, input: JsonLdRuleInput): RuleEvaluation {
  const sources: RuleEvaluation['requiredSources'] = ['admin', 'jsonld'];
  if (context.availability.state === 'inconclusive') {
    return evaluation(context, 'ST-001', 'inconclusive', 'medium', 'admin_inconclusive', sources, input.match);
  }
  if (context.availability.state === 'purchasable') {
    return evaluation(context, 'ST-001', 'not_applicable', 'medium', 'admin_purchasable', sources, input.match);
  }
  if (input.sourceOutcome !== 'observed') {
    return evaluation(context, 'ST-001', 'inconclusive', 'medium', 'jsonld_inconclusive', sources, input.match);
  }
  if (input.match === null || input.match.outcome !== 'matched' || input.claimKind !== 'Offer' || input.coherentClaimCount !== 1) {
    return evaluation(context, 'ST-001', 'inconclusive', 'medium', 'variant_offer_not_exact', sources, input.match);
  }
  if (input.availabilityCanonical === 'InStock') {
    return evaluation(context, 'ST-001', 'fail', 'medium', 'jsonld_in_stock_while_admin_unavailable', sources, input.match);
  }
  if (['OutOfStock', 'SoldOut', 'Discontinued'].includes(input.availabilityCanonical ?? '')) {
    return evaluation(context, 'ST-001', 'pass', 'medium', 'jsonld_reports_unavailable', sources, input.match);
  }
  return evaluation(context, 'ST-001', 'inconclusive', 'medium', 'unsupported_jsonld_availability', sources, input.match);
}

function browserMatch(observation: BrowserVariantObservation | null, match: VariantMatch | null): boolean {
  return observation !== null && observation.outcome === 'observed' && observation.storefrontPurchasable !== null &&
    match !== null && match.outcome === 'matched' &&
    observation.selectedLegacyVariantId === match.legacyVariantId;
}

export function evaluateST002(
  context: Context,
  observation: BrowserVariantObservation | null,
  match: VariantMatch | null,
): RuleEvaluation {
  const sources: RuleEvaluation['requiredSources'] = ['admin', 'browser'];
  if (context.availability.state === 'inconclusive') {
    return evaluation(context, 'ST-002', 'inconclusive', 'high', 'admin_inconclusive', sources, match);
  }
  if (context.availability.state === 'purchasable') {
    return evaluation(context, 'ST-002', 'not_applicable', 'high', 'admin_purchasable', sources, match);
  }
  if (!browserMatch(observation, match)) {
    return evaluation(context, 'ST-002', 'inconclusive', 'high', 'browser_variant_inconclusive', sources, match);
  }
  return observation!.storefrontPurchasable
    ? evaluation(context, 'ST-002', 'fail', 'high', 'storefront_permits_admin_unavailable', sources, match)
    : evaluation(context, 'ST-002', 'pass', 'high', 'storefront_blocks_admin_unavailable', sources, match);
}

export function evaluateST003(
  context: Context,
  observation: BrowserVariantObservation | null,
  match: VariantMatch | null,
): RuleEvaluation {
  const sources: RuleEvaluation['requiredSources'] = ['admin', 'browser'];
  if (context.availability.state === 'inconclusive') {
    return evaluation(context, 'ST-003', 'inconclusive', 'high', 'admin_inconclusive', sources, match);
  }
  if (context.availability.state === 'unavailable') {
    return evaluation(context, 'ST-003', 'not_applicable', 'high', 'admin_unavailable', sources, match);
  }
  if (!browserMatch(observation, match)) {
    return evaluation(context, 'ST-003', 'inconclusive', 'high', 'browser_variant_inconclusive', sources, match);
  }
  return observation!.storefrontPurchasable
    ? evaluation(context, 'ST-003', 'pass', 'high', 'storefront_permits_admin_purchasable', sources, match)
    : evaluation(context, 'ST-003', 'fail', 'high', 'storefront_blocks_admin_purchasable', sources, match);
}
