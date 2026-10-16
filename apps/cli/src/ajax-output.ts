import type { AjaxScanResult } from '../../../packages/agent/src/ajax-scan.js';

export function formatAjaxScan(result: AjaxScanResult): string[] {
  const report = result.report;
  const lines = [
    'AJAX ONLY — cookieless public JSON observation; not a universal shopper verdict.',
    `Outcome: ${report.outcome.toUpperCase()}${report.reasonCode ? ` (${report.reasonCode})` : ''}`,
    `Matched variants: ${report.matchCounts.matched}`,
  ];
  if (report.outcome === 'observed' && report.availabilityCounts !== null) {
    lines.push(`Available variants: ${report.availabilityCounts.available}`);
    lines.push(`Unavailable variants: ${report.availabilityCounts.unavailable}`);
  }
  lines.push('Context: unauthenticated CLI host; cookies sent: no; country/language: not explicit.');
  lines.push('Evidence saved locally.');
  return lines;
}
