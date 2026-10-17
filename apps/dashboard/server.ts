import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCatalogRepository } from '../../packages/database/src/catalog-repository.js';
import type {
  DashboardConnection,
  DashboardIncidentDetail,
  DashboardIncidentSummary,
  DashboardOverview,
  DashboardRerunResult,
} from '../../packages/shared/src/dashboard.js';
import { dashboardConnectionSchema } from '../../packages/shared/src/dashboard.js';
import { runBrowserRegressionTests } from '../../packages/test-runner/src/index.js';
import { SystemCredentialStore } from '../../packages/agent/src/credentials.js';

export type DashboardDataSource = {
  overview(): Promise<DashboardOverview>;
  incidents(status?: 'open' | 'resolved' | 'ignored'): Promise<DashboardIncidentSummary[]>;
  incident(id: string): Promise<DashboardIncidentDetail | null>;
  evidence(runId: string, artifact: EvidenceArtifactName): Promise<DashboardEvidence | null>;
  rerun(): Promise<DashboardRerunResult>;
  connection(): Promise<DashboardConnection>;
};

type EvidenceArtifactName = 'admin.json' | 'ajax.json' | 'html.html' | 'jsonld.json' | 'browser.json';
type DashboardEvidence = { body: Buffer; mediaType: string; filename: EvidenceArtifactName };

export type DashboardServer = {
  url: string;
  close(): Promise<void>;
};

const staticRoot = join(dirname(fileURLToPath(import.meta.url)), 'client');

export function createDashboardDataSource(directory: string, shop: string | null): DashboardDataSource {
  let rerunInProgress = false;
  return {
    async overview() {
      const repository = await openCatalogRepository(directory);
      try { return repository.dashboardOverview(shop); } finally { repository.close(); }
    },
    async incidents(status) {
      if (!shop) return [];
      const repository = await openCatalogRepository(directory);
      try { return repository.listDashboardIncidents(shop, status); } finally { repository.close(); }
    },
    async incident(id) {
      if (!shop) return null;
      const repository = await openCatalogRepository(directory);
      try { return repository.dashboardIncident(shop, id); } finally { repository.close(); }
    },
    async evidence(runId, artifact) {
      if (!shop) return null;
      const repository = await openCatalogRepository(directory);
      let indexed;
      try { indexed = repository.dashboardEvidenceArtifact(shop, runId, artifact); }
      finally { repository.close(); }
      if (!indexed) return null;
      const path = join(directory, 'artifacts', 'scans', runId, indexed.relativePath);
      const details = await lstat(path);
      if (!details.isFile() || details.isSymbolicLink() || details.size !== indexed.bytes) {
        throw new Error('Evidence artifact integrity check failed.');
      }
      const body = await readFile(path);
      if (createHash('sha256').update(body).digest('hex') !== indexed.sha256) {
        throw new Error('Evidence artifact integrity check failed.');
      }
      return { body, mediaType: indexed.mediaType, filename: artifact };
    },
    async rerun() {
      if (rerunInProgress) throw new Error('A dashboard rerun is already in progress.');
      rerunInProgress = true;
      try {
        const result = await runBrowserRegressionTests(directory, false);
        return result.summary ? {
          status: result.summary.status,
          passed: result.summary.passed,
          failed: result.summary.failed,
          inconclusive: result.summary.inconclusive,
        } : { status: 'no_tests', passed: 0, failed: 0, inconclusive: 0 };
      } finally {
        rerunInProgress = false;
      }
    },
    async connection() {
      if (!shop) {
        return dashboardConnectionSchema.parse({
          shop: null, configuration: 'unconfigured', credentialStorage: 'unconfigured',
          catalog: { products: 0, variants: 0, imports: 0 },
          monitoring: { selected: 0, active: 0, limit: 10 },
          localData: { evidenceRuns: 0, incidents: 0, testRuns: 0, retention: 'manual' },
        });
      }
      let credentialStorage: DashboardConnection['credentialStorage'];
      try { credentialStorage = await new SystemCredentialStore().getToken(shop) ? 'stored' : 'missing'; }
      catch { credentialStorage = 'unavailable'; }
      const repository = await openCatalogRepository(directory);
      try {
        const catalog = repository.catalogCounts(shop);
        const monitoring = repository.monitoringSummary(shop);
        const localData = repository.dashboardDataCounts(shop);
        return dashboardConnectionSchema.parse({
          shop, configuration: 'ready', credentialStorage, catalog,
          monitoring: {
            selected: monitoring.monitoredProductCount,
            active: monitoring.activeMonitoredProductCount,
            limit: monitoring.limit,
          },
          localData: { ...localData, retention: 'manual' },
        });
      } finally { repository.close(); }
    },
  };
}

function safeHost(host: string | undefined): boolean {
  if (!host) return false;
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0];
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  response.end(body);
}

async function sendStatic(response: ServerResponse, pathname: string): Promise<boolean> {
  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (relativePath !== 'index.html' && !/^assets\/[a-zA-Z0-9_.-]+$/.test(relativePath)) return false;
  let body: Buffer;
  try { body = await readFile(join(staticRoot, relativePath)); }
  catch { return false; }
  const contentTypes: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
  };
  response.writeHead(200, {
    'Content-Type': contentTypes[extname(relativePath)] ?? 'application/octet-stream',
    'Content-Length': body.byteLength,
    'Cache-Control': relativePath === 'index.html' ? 'no-store' : 'public, max-age=31536000, immutable',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  response.end(body);
  return true;
}

function sendEvidence(response: ServerResponse, evidence: DashboardEvidence): void {
  const contentType = evidence.mediaType === 'text/html'
    ? 'text/plain; charset=utf-8'
    : 'application/json; charset=utf-8';
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': evidence.body.byteLength,
    'Content-Disposition': `inline; filename="${evidence.filename}"`,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  response.end(evidence.body);
}

function routeId(pathname: string): string | null {
  const match = /^\/api\/incidents\/([0-9a-f-]+)$/.exec(pathname);
  return match?.[1] ?? null;
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  data: DashboardDataSource,
): Promise<void> {
  if (!safeHost(request.headers.host)) {
    sendJson(response, 403, { error: 'invalid_host' });
    return;
  }
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (request.method === 'POST' && url.pathname === '/api/tests/rerun') {
    const expectedOrigin = `http://${request.headers.host}`;
    if (request.headers.origin !== expectedOrigin) {
      sendJson(response, 403, { error: 'invalid_origin' });
      return;
    }
    sendJson(response, 200, await data.rerun());
    return;
  }
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    sendJson(response, 405, { error: 'method_not_allowed' });
    return;
  }
  if (!url.pathname.startsWith('/api/') && await sendStatic(response, url.pathname)) return;
  const evidenceMatch = /^\/api\/evidence\/([0-9a-f-]+)\/(admin\.json|ajax\.json|html\.html|jsonld\.json|browser\.json)$/.exec(url.pathname);
  if (evidenceMatch) {
    const runId = evidenceMatch[1];
    const artifact = evidenceMatch[2] as EvidenceArtifactName;
    if (!runId) { sendJson(response, 404, { error: 'evidence_not_found' }); return; }
    const evidence = await data.evidence(runId, artifact);
    if (!evidence) { sendJson(response, 404, { error: 'evidence_not_found' }); return; }
    sendEvidence(response, evidence);
    return;
  }
  if (url.pathname === '/api/overview') {
    sendJson(response, 200, await data.overview());
    return;
  }
  if (url.pathname === '/api/connection') {
    sendJson(response, 200, await data.connection());
    return;
  }
  if (url.pathname === '/api/incidents') {
    const rawStatus = url.searchParams.get('status');
    if (rawStatus && rawStatus !== 'open' && rawStatus !== 'resolved' && rawStatus !== 'ignored') {
      sendJson(response, 400, { error: 'invalid_status' });
      return;
    }
    const status = rawStatus === 'open' || rawStatus === 'resolved' || rawStatus === 'ignored'
      ? rawStatus
      : undefined;
    sendJson(response, 200, await data.incidents(status));
    return;
  }
  const incidentId = routeId(url.pathname);
  if (incidentId) {
    const incident = await data.incident(incidentId);
    sendJson(response, incident ? 200 : 404, incident ?? { error: 'incident_not_found' });
    return;
  }
  sendJson(response, 404, { error: 'not_found' });
}

export async function startDashboardServer(
  data: DashboardDataSource,
  options: { port?: number; host?: '127.0.0.1' } = {},
): Promise<DashboardServer> {
  const server = createServer((request, response) => {
    void routeRequest(request, response, data).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: 'dashboard_unavailable' });
      else response.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4173, options.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Dashboard server did not obtain a loopback port.');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}
