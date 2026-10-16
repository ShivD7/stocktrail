import type { CombinedScanResult } from '../../../packages/agent/src/combined-scan.js';

export function formatEvidenceBundle(result: CombinedScanResult): string[] {
  const { sources } = result.bundle;
  const label = (outcome: string, reason: string | null) =>
    `${outcome.toUpperCase()}${reason === null ? '' : ` (${reason})`}`;
  const all = [sources.admin, sources.ajax, sources.html, sources.jsonld];
  const observed = all.filter(source => source.outcome === 'observed').length;
  return [
    'EVIDENCE BUNDLE — collection only; no availability verdict.',
    `Admin: ${label(sources.admin.outcome, sources.admin.reasonCode)}; variants: ${sources.admin.itemCount}.`,
    `Storefront Ajax: ${label(sources.ajax.outcome, sources.ajax.reasonCode)}; variants: ${sources.ajax.itemCount}.`,
    `Storefront HTML: ${label(sources.html.outcome, sources.html.reasonCode)}; documents: ${sources.html.itemCount}.`,
    `Search data JSON-LD: ${label(sources.jsonld.outcome, sources.jsonld.reasonCode)}; blocks: ${sources.jsonld.blockCount}; claims: ${sources.jsonld.itemCount}.`,
    `Sources observed: ${observed}; inconclusive: ${all.length - observed}.`,
    'Evidence saved locally.',
  ];
}
