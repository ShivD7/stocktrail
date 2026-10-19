import type { ScanPerformanceResult } from '../../../packages/agent/src/performance.js';

export function formatScanPerformance(result: ScanPerformanceResult): string[] {
  return [
    `Duration: ${result.durationMs} ms`,
    `Completed: ${result.completed}`,
    `Failed: ${result.failed}`,
    `Admin API calls: ${result.adminRequestCount}`,
  ];
}
