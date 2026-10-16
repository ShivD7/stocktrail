// A demo-only rule. Live availability also needs publication, markets, and location evidence.
export type Observation = {
  variantId: string;
  title: string;
  tracked: boolean;
  quantity: number | null;
  continueSelling: boolean;
  published: boolean;
  storefrontAvailable: boolean | null;
};

export type Finding = {
  variantId: string;
  title: string;
  status: 'pass' | 'fail' | 'inconclusive';
  expected: boolean | null;
  observed: boolean | null;
};

export function compareAvailability(input: Observation): Finding {
  let expected: boolean | null;
  if (!input.published) expected = false;
  else if (!input.tracked || input.continueSelling) expected = true;
  else expected = input.quantity === null || !Number.isFinite(input.quantity) ? null : input.quantity > 0;
  const observed = input.storefrontAvailable;
  return {
    variantId: input.variantId, title: input.title, expected, observed,
    status: expected === null || observed === null ? 'inconclusive' : expected === observed ? 'pass' : 'fail',
  };
}

export { deriveExpectedPurchasable } from './admin-availability.js';
export {
  coalesceVariantMatches,
  matchVariantReference,
  normalizeOptionName,
  normalizeOptionValue,
} from './variant-matcher.js';
export { evaluateST001, evaluateST002, evaluateST003 } from './rules.js';
export { evaluateVariantDiagnostics } from './diagnostic.js';
