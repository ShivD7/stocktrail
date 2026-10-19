import { listMonitoringCandidates } from './monitoring.js';
import { scanEvidenceBundle, type CombinedScanResult } from './combined-scan.js';
import type { MonitoringCandidate } from '../../database/src/catalog-repository.js';

const PERFORMANCE_PRODUCT_COUNT = 10;

export type ScanPerformanceResult = {
  durationMs: number;
  completed: number;
  failed: number;
  adminRequestCount: number;
};

export type ScanPerformanceDependencies = {
  listCandidates(directory: string): Promise<MonitoringCandidate[]>;
  scan(
    directory: string,
    productId: string,
    context: { signal?: AbortSignal; onAdminRequest(): void },
  ): Promise<CombinedScanResult>;
  now(): number;
};

export type ScanPerformanceOptions = {
  signal?: AbortSignal;
};

export class ScanPerformanceCancelledError extends Error {}

const defaultDependencies: ScanPerformanceDependencies = {
  listCandidates: listMonitoringCandidates,
  scan: (directory, productId, context) => scanEvidenceBundle(directory, productId, undefined, {
    browser: true,
    cartAdd: false,
    signal: context.signal,
    onAdminRequest: context.onAdminRequest,
  }),
  now: Date.now,
};

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ScanPerformanceCancelledError('Performance measurement was cancelled.');
}

export async function measureTenProductScanPerformance(
  directory: string,
  dependencies: ScanPerformanceDependencies = defaultDependencies,
  options: ScanPerformanceOptions = {},
): Promise<ScanPerformanceResult> {
  const candidates = await dependencies.listCandidates(directory);
  const selected = candidates.filter(candidate => candidate.monitored && candidate.present);
  if (selected.length !== PERFORMANCE_PRODUCT_COUNT) {
    throw new Error('Performance measurement requires exactly 10 active monitored products.');
  }

  throwIfCancelled(options.signal);
  const startedAt = dependencies.now();
  let completed = 0;
  let failed = 0;
  let adminRequestCount = 0;
  const onAdminRequest = () => { adminRequestCount += 1; };

  for (const candidate of selected) {
    throwIfCancelled(options.signal);
    try {
      await dependencies.scan(directory, candidate.productGid, {
        signal: options.signal,
        onAdminRequest,
      });
      completed += 1;
    } catch {
      throwIfCancelled(options.signal);
      failed += 1;
    }
  }

  const elapsed = dependencies.now() - startedAt;
  return {
    durationMs: Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : 0,
    completed,
    failed,
    adminRequestCount,
  };
}
