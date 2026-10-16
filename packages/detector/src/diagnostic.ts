import type { AdminEvidenceReport } from '../../shared/src/admin-evidence.js';
import type {
  BrowserVariantObservation,
  RuleEvaluation,
  VariantMatch,
  VariantReference,
} from '../../shared/src/diagnostics.js';
import { deriveExpectedPurchasable } from './admin-availability.js';
import { matchVariantReference, type MatchableAdminVariant } from './variant-matcher.js';
import { evaluateST001, evaluateST002, evaluateST003 } from './rules.js';

export type VariantDiagnosticInput = {
  admin: AdminEvidenceReport;
  variantId: string;
  evidenceRunId: string;
  evaluatedAt: string;
  jsonLd: {
    sourceOutcome: 'observed' | 'inconclusive';
    reference: VariantReference | null;
    claimKind: 'Offer' | 'Product' | 'ProductGroup' | 'AggregateOffer' | null;
    availabilityCanonical: string | null;
    coherentClaimCount: number;
  };
  browser: BrowserVariantObservation | null;
};

export type VariantDiagnosticResult = {
  evaluations: RuleEvaluation[];
  matches: VariantMatch[];
};

export function evaluateVariantDiagnostics(input: VariantDiagnosticInput): VariantDiagnosticResult {
  const variants = input.admin.product.variants as MatchableAdminVariant[];
  const variant = variants.find(value => value.id === input.variantId) ?? null;
  const availability = deriveExpectedPurchasable(input.admin, variant);
  const context = { availability, evidenceRunId: input.evidenceRunId, evaluatedAt: input.evaluatedAt };
  const jsonLdMatch = input.jsonLd.reference === null
    ? null : matchVariantReference(variants, input.jsonLd.reference);
  const browserReference: VariantReference | null = input.browser === null ? null : {
    source: 'browser',
    legacyVariantId: input.browser.selectedLegacyVariantId,
    sku: null,
    selectedOptions: null,
  };
  const browserMatch = browserReference === null ? null : matchVariantReference(variants, browserReference);
  return {
    evaluations: [
      evaluateST001(context, {
        sourceOutcome: input.jsonLd.sourceOutcome,
        match: jsonLdMatch,
        claimKind: input.jsonLd.claimKind,
        availabilityCanonical: input.jsonLd.availabilityCanonical,
        coherentClaimCount: input.jsonLd.coherentClaimCount,
      }),
      evaluateST002(context, input.browser, browserMatch),
      evaluateST003(context, input.browser, browserMatch),
    ],
    matches: [jsonLdMatch, browserMatch].filter((value): value is VariantMatch => value !== null),
  };
}
