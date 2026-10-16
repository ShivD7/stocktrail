import type { CombinedScanResult } from '../../../packages/agent/src/combined-scan.js';

export function formatEvidenceBundle(result: CombinedScanResult): string[] {
  const { sources } = result.bundle;
  const label = (outcome: string, reason: string | null) =>
    `${outcome.toUpperCase()}${reason === null ? '' : ` (${reason})`}`;
  const browser = result.bundle.schemaVersion === 2 ? result.bundle.sources.browser : null;
  const all = [sources.admin, sources.ajax, sources.html, sources.jsonld, ...(browser === null ? [] : [browser])];
  const observed = all.filter(source => source.outcome === 'observed').length;
  const lines = [
    result.evaluations === undefined
      ? 'EVIDENCE BUNDLE — collection only; no availability verdict.'
      : 'BROWSER DIAGNOSTIC — aggregate results from fresh isolated evidence.',
    `Admin: ${label(sources.admin.outcome, sources.admin.reasonCode)}; variants: ${sources.admin.itemCount}.`,
    `Storefront Ajax: ${label(sources.ajax.outcome, sources.ajax.reasonCode)}; variants: ${sources.ajax.itemCount}.`,
    `Storefront HTML: ${label(sources.html.outcome, sources.html.reasonCode)}; documents: ${sources.html.itemCount}.`,
    `Search data JSON-LD: ${label(sources.jsonld.outcome, sources.jsonld.reasonCode)}; blocks: ${sources.jsonld.blockCount}; claims: ${sources.jsonld.itemCount}.`,
  ];
  if (browser !== null) lines.push(`Browser: ${label(browser.outcome, browser.reasonCode)}; variants: ${browser.itemCount}.`);
  lines.push(`Sources observed: ${observed}; inconclusive: ${all.length - observed}.`);
  if (result.evaluations !== undefined) {
    const counts = { pass: 0, fail: 0, inconclusive: 0, not_applicable: 0 };
    for (const evaluation of result.evaluations) counts[evaluation.result] += 1;
    lines.push(`Rules: ${counts.pass} passed; ${counts.fail} failed; ${counts.inconclusive} inconclusive; ${counts.not_applicable} not applicable.`);
    lines.push(`Inventory Search Readiness: ${result.readinessTotal === null ? 'inconclusive' : `${result.readinessTotal}/100`}.`);
  }
  lines.push('Evidence saved locally.');
  return lines;
}
