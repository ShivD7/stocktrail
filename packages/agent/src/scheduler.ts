import { randomUUID } from 'node:crypto';
import { readConfig, type Config } from './config.js';
import { scanEvidenceBundle, type CombinedScanOptions } from './combined-scan.js';
import {
  openCatalogRepository,
  type CatalogRepository,
  type ScanSchedule,
} from '../../database/src/catalog-repository.js';

export type ScheduledScanStatus = 'completed' | 'not_due' | 'already_running' | 'cancelled';

export const SCHEDULE_STALE_RUN_MS = 6 * 60 * 60 * 1_000;

export type ScheduledScanSummary = {
  status: ScheduledScanStatus;
  selectedProductCount: number;
  attemptedProductCount: number;
  succeededProductCount: number;
  failedProductCount: number;
};

type SchedulerRepository = Pick<CatalogRepository,
  'scanSchedule' | 'configureScanSchedule' | 'claimScanSchedule' | 'activeMonitoredProductGids' |
  'completeScanSchedule' | 'abandonScanSchedule' | 'close'>;

export type ScheduledScanDependencies = {
  readConfig(directory: string): Promise<Config>;
  openRepository(directory: string): Promise<SchedulerRepository>;
  scan(directory: string, productId: string, options: CombinedScanOptions): Promise<unknown>;
  now(): Date;
  uuid(): string;
};

const defaultDependencies: ScheduledScanDependencies = {
  readConfig,
  openRepository: openCatalogRepository,
  scan: (directory, productId, options) => scanEvidenceBundle(directory, productId, undefined, options),
  now: () => new Date(),
  uuid: randomUUID,
};

function emptySummary(status: ScheduledScanStatus): ScheduledScanSummary {
  return {
    status,
    selectedProductCount: 0,
    attemptedProductCount: 0,
    succeededProductCount: 0,
    failedProductCount: 0,
  };
}

export async function configureScheduledScans(
  directory: string,
  intervalMinutes: number,
  dependencies: ScheduledScanDependencies = defaultDependencies,
): Promise<ScanSchedule> {
  const config = await dependencies.readConfig(directory);
  if (!config.shop) throw new Error('No shop is configured. Run stocktrail init first.');
  if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 10_080) {
    throw new Error('Schedule interval must be a whole number from 1 to 10080 minutes.');
  }
  const nextDueAt = new Date(dependencies.now().getTime() + intervalMinutes * 60_000).toISOString();
  const repository = await dependencies.openRepository(directory);
  try {
    return repository.configureScanSchedule(config.shop, intervalMinutes, nextDueAt);
  } finally {
    repository.close();
  }
}

export async function scheduledScanStatus(
  directory: string,
  dependencies: ScheduledScanDependencies = defaultDependencies,
): Promise<ScanSchedule | null> {
  const config = await dependencies.readConfig(directory);
  if (!config.shop) throw new Error('No shop is configured. Run stocktrail init first.');
  const repository = await dependencies.openRepository(directory);
  try {
    return repository.scanSchedule(config.shop);
  } finally {
    repository.close();
  }
}

export async function runScheduledScans(
  directory: string,
  options: { force?: boolean; signal?: AbortSignal } = {},
  dependencies: ScheduledScanDependencies = defaultDependencies,
): Promise<ScheduledScanSummary> {
  const config = await dependencies.readConfig(directory);
  if (!config.shop) throw new Error('No shop is configured. Run stocktrail init first.');
  const runId = dependencies.uuid();
  const startedAt = dependencies.now().toISOString();
  const staleBeforeAt = new Date(Date.parse(startedAt) - SCHEDULE_STALE_RUN_MS).toISOString();
  const repository = await dependencies.openRepository(directory);
  let productIds: string[];
  try {
    const before = repository.scanSchedule(config.shop);
    if (!before) throw new Error('No scan schedule is configured.');
    const claimed = repository.claimScanSchedule(
      config.shop,
      runId,
      startedAt,
      options.force === true,
      staleBeforeAt,
    );
    if (!claimed) return emptySummary(before.activeRunId === null ? 'not_due' : 'already_running');
    productIds = repository.activeMonitoredProductGids(config.shop);
  } finally {
    repository.close();
  }

  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  let cancelled = options.signal?.aborted === true;
  try {
    for (const productId of productIds) {
      if (options.signal?.aborted) {
        cancelled = true;
        break;
      }
      attempted += 1;
      try {
        await dependencies.scan(directory, productId, {
          browser: true,
          cartAdd: false,
          signal: options.signal,
        });
        succeeded += 1;
      } catch {
        if (options.signal?.aborted) {
          cancelled = true;
          break;
        }
        failed += 1;
      }
    }
  } finally {
    const completionRepository = await dependencies.openRepository(directory);
    try {
      if (cancelled) completionRepository.abandonScanSchedule(config.shop, runId);
      else completionRepository.completeScanSchedule(config.shop, runId, dependencies.now().toISOString());
    } finally {
      completionRepository.close();
    }
  }

  return {
    status: cancelled ? 'cancelled' : 'completed',
    selectedProductCount: productIds.length,
    attemptedProductCount: attempted,
    succeededProductCount: succeeded,
    failedProductCount: failed,
  };
}
