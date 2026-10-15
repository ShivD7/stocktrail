import { readConfig } from './config.js';
import {
  openCatalogRepository,
  type MonitoringCandidate,
  type MonitoringSummary,
} from '../../database/src/catalog-repository.js';

type MonitoringAction = 'add' | 'remove' | 'list';

export async function updateMonitoringSelection(
  directory: string,
  action: MonitoringAction,
  productGid?: string,
): Promise<MonitoringSummary> {
  const config = await readConfig(directory);
  if (!config.shop) throw new Error('No shop is configured. Run stocktrail init --shop your-store.myshopify.com first.');
  if ((action === 'add' || action === 'remove') && productGid === undefined) {
    throw new Error('--product-id is required when adding or removing a monitored product.');
  }
  const repository = await openCatalogRepository(directory);
  try {
    if (action === 'add') return repository.addMonitoredProduct(config.shop, productGid!);
    if (action === 'remove') return repository.removeMonitoredProduct(config.shop, productGid!);
    return repository.monitoringSummary(config.shop);
  } finally {
    repository.close();
  }
}

export async function listMonitoringCandidates(directory: string): Promise<MonitoringCandidate[]> {
  const config = await readConfig(directory);
  if (!config.shop) throw new Error('No shop is configured. Run stocktrail init --shop your-store.myshopify.com first.');
  const repository = await openCatalogRepository(directory);
  try {
    return repository.monitoringCandidates(config.shop);
  } finally {
    repository.close();
  }
}
