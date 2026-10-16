import type { AdminEvidenceReport } from '../../shared/src/admin-evidence.js';
import {
  variantMatchSchema,
  type VariantMatch,
  type VariantReference,
} from '../../shared/src/diagnostics.js';

export type MatchableAdminVariant = AdminEvidenceReport['product']['variants'][number] & {
  sku?: string | null;
};

function normalizedWhitespace(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

export function normalizeOptionName(value: string): string {
  return normalizedWhitespace(value).toLocaleLowerCase('en-US');
}

export function normalizeOptionValue(value: string): string {
  return normalizedWhitespace(value);
}

function optionKey(options: Array<{ name: string; value: string }>): string | null {
  const normalized = options.map(option => ({
    name: normalizeOptionName(option.name),
    value: normalizeOptionValue(option.value),
  }));
  if (normalized.some(option => !option.name || !option.value)) return null;
  const names = new Set(normalized.map(option => option.name));
  if (names.size !== normalized.length) return null;
  normalized.sort((left, right) => left.name.localeCompare(right.name));
  return JSON.stringify(normalized);
}

function matched(
  variant: MatchableAdminVariant,
  method: 'variant_id' | 'sku' | 'selected_options',
  corroboratingMethods: Array<'variant_id' | 'sku' | 'selected_options'>,
): VariantMatch {
  const confidence = method === 'variant_id' ? 'authoritative'
    : method === 'sku' ? 'strong' : 'contextual';
  return variantMatchSchema.parse({
    outcome: 'matched', variantId: variant.id, legacyVariantId: variant.legacyResourceId,
    method, confidence, corroboratingMethods,
  });
}

function inconclusive(reasonCode: Extract<VariantMatch, { outcome: 'inconclusive' }>['reasonCode'], candidateCount = 0): VariantMatch {
  return variantMatchSchema.parse({ outcome: 'inconclusive', reasonCode, candidateCount });
}

export function matchVariantReference(
  variants: MatchableAdminVariant[],
  reference: VariantReference,
): VariantMatch {
  const suppliedId = reference.legacyVariantId;
  const suppliedSku = reference.sku !== null && reference.sku.length > 0 ? reference.sku : null;
  const suppliedOptionsKey = reference.selectedOptions === null ? null : optionKey(reference.selectedOptions);
  if (suppliedId === null && suppliedSku === null && suppliedOptionsKey === null) {
    return inconclusive('missing_identifier');
  }

  const byId = suppliedId === null ? [] : variants.filter(variant => variant.legacyResourceId === suppliedId);
  if (suppliedId !== null && byId.length !== 1) return inconclusive('unknown_variant_id', byId.length);

  const bySku = suppliedSku === null ? [] : variants.filter(variant => variant.sku === suppliedSku);
  if (suppliedSku !== null && bySku.length > 1) return inconclusive('duplicate_sku', bySku.length);

  const byOptions = suppliedOptionsKey === null ? [] : variants.filter(variant => optionKey(variant.selectedOptions) === suppliedOptionsKey);
  if (suppliedOptionsKey !== null && byOptions.length > 1) return inconclusive('ambiguous_options', byOptions.length);

  const candidates = [
    suppliedId === null ? null : byId[0] ?? null,
    suppliedSku === null ? null : bySku[0] ?? null,
    suppliedOptionsKey === null ? null : byOptions[0] ?? null,
  ].filter((variant): variant is MatchableAdminVariant => variant !== null);
  if (new Set(candidates.map(candidate => candidate.id)).size > 1) {
    return inconclusive('conflicting_identifiers', candidates.length);
  }

  if (suppliedId !== null) {
    const candidate = byId[0]!;
    if ((suppliedSku !== null && bySku.length === 0) || (suppliedOptionsKey !== null && byOptions.length === 0)) {
      return inconclusive('conflicting_identifiers', 1);
    }
    return matched(candidate, 'variant_id', [
      'variant_id', ...(suppliedSku === null ? [] : ['sku'] as const),
      ...(suppliedOptionsKey === null ? [] : ['selected_options'] as const),
    ]);
  }
  if (suppliedSku !== null) {
    if (bySku.length === 0) return inconclusive('missing_identifier');
    const candidate = bySku[0]!;
    if (suppliedOptionsKey !== null && byOptions.length === 0) return inconclusive('conflicting_identifiers', 1);
    return matched(candidate, 'sku', ['sku', ...(suppliedOptionsKey === null ? [] : ['selected_options'] as const)]);
  }
  if (byOptions.length !== 1) return inconclusive('missing_identifier', byOptions.length);
  return matched(byOptions[0]!, 'selected_options', ['selected_options']);
}

export function coalesceVariantMatches(matches: VariantMatch[]): VariantMatch {
  const inconclusiveMatch = matches.find(match => match.outcome === 'inconclusive');
  if (inconclusiveMatch !== undefined) return inconclusiveMatch;
  if (matches.length === 0) return inconclusive('missing_identifier');
  const matchedValues = matches as Array<Extract<VariantMatch, { outcome: 'matched' }>>;
  const ids = new Set(matchedValues.map(match => match.variantId));
  if (ids.size !== 1) return inconclusive('conflicting_source_claims', ids.size);
  return matchedValues[0]!;
}
