import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { compareAvailability, type Observation } from '../../detector/src/index.js';

export async function scanDemo(directory: string) {
  const observations: Observation[] = [
    { variantId: 'demo-red-10', title: 'Red Running Shoe / Size 10', tracked: true, quantity: 0, continueSelling: false, published: true, storefrontAvailable: true },
    { variantId: 'demo-blue-8', title: 'Blue Hiking Boot / Size 8', tracked: true, quantity: 5, continueSelling: false, published: true, storefrontAvailable: true },
  ];
  const report = {
    schemaVersion: 1, mode: 'demo', collectedAt: new Date().toISOString(),
    limitations: ['Synthetic fixtures only; no Shopify connection.', 'Simplified availability rule; not a live inventory verdict.'],
    observations, findings: observations.map(compareAvailability),
  };
  const reports = join(directory, 'reports');
  await mkdir(reports, { recursive: true });
  const path = join(reports, `demo-${randomUUID()}.json`);
  await writeFile(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { report, path };
}
