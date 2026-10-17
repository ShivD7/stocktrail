import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { openCatalogRepository } from '../../packages/database/src/catalog-repository.js';
import type {
  DashboardIncidentDetail,
  DashboardIncidentSummary,
  DashboardOverview,
} from '../../packages/shared/src/dashboard.js';

export type DashboardDataSource = {
  overview(): Promise<DashboardOverview>;
  incidents(status?: 'open' | 'resolved' | 'ignored'): Promise<DashboardIncidentSummary[]>;
  incident(id: string): Promise<DashboardIncidentDetail | null>;
};

export type DashboardServer = {
  url: string;
  close(): Promise<void>;
};

export function createDashboardDataSource(directory: string, shop: string | null): DashboardDataSource {
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
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    sendJson(response, 405, { error: 'method_not_allowed' });
    return;
  }
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/overview') {
    sendJson(response, 200, await data.overview());
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
