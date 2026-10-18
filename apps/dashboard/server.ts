import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z, type ZodType } from 'zod';
import { openCatalogRepository } from '../../packages/database/src/catalog-repository.js';
import {
  dashboardApplyRequestSchema,
  dashboardApplyResultSchema,
  dashboardConnectionSchema,
  dashboardEmptyRequestSchema,
  dashboardErrorSchema,
  dashboardImproveResultSchema,
  dashboardImportRequestSchema,
  dashboardImportResultSchema,
  dashboardIncidentDetailSchema,
  dashboardIncidentSummarySchema,
  dashboardMonitoringRequestSchema,
  dashboardMonitoringResultSchema,
  dashboardOverviewSchema,
  dashboardProductDetailSchema,
  dashboardProductSummarySchema,
  dashboardProposalActionResultSchema,
  dashboardProposalDetailSchema,
  dashboardRerunResultSchema,
  dashboardRevertResultSchema,
  dashboardScanRequestSchema,
  dashboardScanResultSchema,
  type DashboardApplyRequest,
  type DashboardApplyResult,
  type DashboardConnection,
  type DashboardErrorCode,
  type DashboardImproveResult,
  type DashboardImportResult,
  type DashboardIncidentDetail,
  type DashboardIncidentSummary,
  type DashboardMonitoringRequest,
  type DashboardMonitoringResult,
  type DashboardOverview,
  type DashboardProductDetail,
  type DashboardProductSummary,
  type DashboardProposalActionResult,
  type DashboardProposalDetail,
  type DashboardRerunResult,
  type DashboardRevertResult,
  type DashboardScanResult,
} from '../../packages/shared/src/dashboard.js';
import { adminEvidenceReportSchema } from '../../packages/shared/src/admin-evidence.js';
import { deriveHtmlProductTarget } from '../../packages/shopify/src/ajax.js';
import {
  createDashboardActions,
  DashboardActionError,
  type DashboardActions,
} from '../../packages/agent/src/dashboard-actions.js';
import { SystemCredentialStore } from '../../packages/agent/src/credentials.js';

type EvidenceSourceName = 'admin' | 'ajax' | 'html' | 'jsonld' | 'browser';
type EvidenceArtifactName = 'admin.json' | 'ajax.json' | 'html.html' | 'jsonld.json' | 'browser.json';
type DashboardEvidence = { body: Buffer; mediaType: string; filename: EvidenceArtifactName };

export type DashboardDataSource = {
  overview(): Promise<DashboardOverview>;
  products(): Promise<DashboardProductSummary[]>;
  product(id: string): Promise<DashboardProductDetail | null>;
  incidents(status?: 'open' | 'resolved' | 'ignored'): Promise<DashboardIncidentSummary[]>;
  incident(id: string): Promise<DashboardIncidentDetail | null>;
  incidentEvidence(id: string, source: EvidenceSourceName): Promise<DashboardEvidence | null>;
  proposal(id: string): Promise<DashboardProposalDetail>;
  connection(): Promise<DashboardConnection>;
  importCatalog(limit: number): Promise<DashboardImportResult>;
  monitoring(input: DashboardMonitoringRequest): Promise<DashboardMonitoringResult>;
  scan(productId: string): Promise<DashboardScanResult>;
  improve(productId: string): Promise<DashboardImproveResult>;
  rerun(incidentId: string): Promise<DashboardRerunResult>;
  reject(proposalId: string): Promise<DashboardProposalActionResult>;
  apply(proposalId: string, input: DashboardApplyRequest): Promise<DashboardApplyResult>;
  reconcile(proposalId: string): Promise<DashboardProposalActionResult>;
  revert(proposalId: string): Promise<DashboardRevertResult>;
};

export type DashboardServer = { url: string; close(): Promise<void> };

const staticRoot = join(dirname(fileURLToPath(import.meta.url)), 'client');
const productsSchema = z.array(dashboardProductSummarySchema);
const incidentsSchema = z.array(dashboardIncidentSummarySchema);
const uuidSchema = z.string().uuid();
const productGidSchema = z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/);
const evidenceSourceSchema = z.enum(['admin', 'ajax', 'html', 'jsonld', 'browser']);
const MAX_BODY_BYTES = 16 * 1024;

function artifactName(source: EvidenceSourceName): EvidenceArtifactName {
  if (source === 'html') return 'html.html';
  return `${source}.json` as EvidenceArtifactName;
}

async function readIndexedEvidence(
  directory: string,
  runId: string,
  indexed: { relativePath: string; mediaType: string; sha256: string; bytes: number },
): Promise<DashboardEvidence> {
  const root = resolve(directory, 'artifacts', 'scans', runId);
  const path = resolve(root, indexed.relativePath);
  const within = relative(root, path);
  if (within.startsWith('..') || isAbsolute(within)) throw new DashboardActionError('artifact_integrity_failed', 500);
  let details;
  try { details = await lstat(path); }
  catch { throw new DashboardActionError('artifact_integrity_failed', 500); }
  if (!details.isFile() || details.isSymbolicLink() || details.size !== indexed.bytes) {
    throw new DashboardActionError('artifact_integrity_failed', 500);
  }
  let body: Buffer;
  try { body = await readFile(path); }
  catch { throw new DashboardActionError('artifact_integrity_failed', 500); }
  if (createHash('sha256').update(body).digest('hex') !== indexed.sha256) {
    throw new DashboardActionError('artifact_integrity_failed', 500);
  }
  return { body, mediaType: indexed.mediaType, filename: indexed.relativePath as EvidenceArtifactName };
}

function validatedProductUrl(body: Buffer, productGid: string): string | null | undefined {
  let value: unknown;
  try { value = JSON.parse(body.toString('utf8')); } catch { return undefined; }
  const parsed = adminEvidenceReportSchema.safeParse(value);
  if (!parsed.success || parsed.data.product.id !== productGid) return undefined;
  if (parsed.data.product.onlineStoreUrl === null) return null;
  try { return deriveHtmlProductTarget(parsed.data.product.onlineStoreUrl).url.href; }
  catch { return undefined; }
}

export function createDashboardDataSource(directory: string, shop: string | null): DashboardDataSource {
  const actions: DashboardActions | null = shop ? createDashboardActions(directory, shop) : null;
  const requireActions = (): DashboardActions => {
    if (!actions) throw new DashboardActionError('unprocessable', 422);
    return actions;
  };
  const freshUrl = async (detail: { productGid: string; productUrl: string | null; latestScan?: { id: string } | null; latestEvidenceRunId?: string }) => {
    if (!shop) return detail.productUrl;
    const runId = detail.latestEvidenceRunId ?? detail.latestScan?.id;
    if (!runId) return detail.productUrl;
    const repository = await openCatalogRepository(directory);
    let indexed;
    try { indexed = repository.dashboardEvidenceArtifact(shop, runId, 'admin.json'); }
    finally { repository.close(); }
    if (!indexed) return detail.productUrl;
    const evidence = await readIndexedEvidence(directory, runId, indexed);
    const validated = validatedProductUrl(evidence.body, detail.productGid);
    return validated === undefined ? detail.productUrl : validated;
  };
  return {
    async overview() {
      const repository = await openCatalogRepository(directory);
      try { return repository.dashboardOverview(shop); } finally { repository.close(); }
    },
    async products() {
      if (!shop) return [];
      const repository = await openCatalogRepository(directory);
      try { return repository.dashboardProducts(shop); } finally { repository.close(); }
    },
    async product(id) {
      if (!shop) return null;
      const repository = await openCatalogRepository(directory);
      let detail;
      try { detail = repository.dashboardProduct(shop, id); } finally { repository.close(); }
      return detail ? { ...detail, productUrl: await freshUrl(detail) } : null;
    },
    async incidents(status) {
      if (!shop) return [];
      const repository = await openCatalogRepository(directory);
      try { return repository.listDashboardIncidents(shop, status); } finally { repository.close(); }
    },
    async incident(id) {
      if (!shop) return null;
      const repository = await openCatalogRepository(directory);
      let detail;
      try { detail = repository.dashboardIncident(shop, id); } finally { repository.close(); }
      return detail ? { ...detail, productUrl: await freshUrl(detail) } : null;
    },
    async incidentEvidence(id, source) {
      if (!shop) return null;
      const repository = await openCatalogRepository(directory);
      let detail;
      let indexed;
      const name = artifactName(source);
      try {
        detail = repository.dashboardIncident(shop, id);
        if (!detail || !detail.sources.some(value => value.source === source && value.artifactPath === name)) return null;
        indexed = repository.dashboardEvidenceArtifact(shop, detail.latestEvidenceRunId, name);
      } finally { repository.close(); }
      return indexed ? readIndexedEvidence(directory, detail.latestEvidenceRunId, indexed) : null;
    },
    proposal: id => requireActions().proposal(id),
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
          monitoring: { selected: monitoring.monitoredProductCount, active: monitoring.activeMonitoredProductCount, limit: monitoring.limit },
          localData: { ...localData, retention: 'manual' },
        });
      } finally { repository.close(); }
    },
    importCatalog: limit => requireActions().importCatalog(limit),
    monitoring: input => requireActions().monitoring(input),
    scan: productId => requireActions().scan(productId),
    improve: productId => requireActions().improve(productId),
    rerun: incidentId => requireActions().rerun(incidentId),
    reject: proposalId => requireActions().reject(proposalId),
    apply: (proposalId, input) => requireActions().apply(proposalId, input),
    reconcile: proposalId => requireActions().reconcile(proposalId),
    revert: proposalId => requireActions().revert(proposalId),
  };
}

export function isExactDashboardAuthority(value: string | null, expected: string): boolean {
  return value === expected && /^127\.0\.0\.1:(?:[1-9]\d{0,4})$/.test(value) && Number(value.slice(value.lastIndexOf(':') + 1)) <= 65_535;
}

function singleRawHeader(request: IncomingMessage, name: string): string | null {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) values.push(request.rawHeaders[index + 1] ?? '');
  }
  return values.length === 1 ? values[0]! : null;
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

function sendError(response: ServerResponse, status: number, code: DashboardErrorCode): void {
  sendJson(response, status, dashboardErrorSchema.parse({ error: code }));
}

function sendValidated<T>(response: ServerResponse, status: number, schema: ZodType<T>, value: unknown): void {
  sendJson(response, status, schema.parse(value));
}

async function sendStatic(response: ServerResponse, pathname: string): Promise<boolean> {
  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (relativePath !== 'index.html' && !/^assets\/[a-zA-Z0-9_.-]+$/.test(relativePath)) return false;
  let body: Buffer;
  try { body = await readFile(join(staticRoot, relativePath)); } catch { return false; }
  const contentTypes: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.map': 'application/json; charset=utf-8',
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
  const contentType = evidence.mediaType === 'text/html' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8';
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

async function readJsonBody<T>(request: IncomingMessage, schema: ZodType<T>): Promise<T> {
  const contentType = singleRawHeader(request, 'content-type');
  if (!contentType || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
    throw new DashboardActionError('unsupported_media_type', 400);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_BODY_BYTES) throw new DashboardActionError('body_too_large', 400);
    chunks.push(bytes);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new DashboardActionError('invalid_request', 400); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new DashboardActionError('invalid_request', 400);
  return parsed.data;
}

function decodedSegment(value: string | undefined, schema: ZodType<string>): string | null {
  if (!value) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { return null; }
  const parsed = schema.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  data: DashboardDataSource,
  expectedAuthority: string,
  active: Set<string>,
): Promise<void> {
  if (!isExactDashboardAuthority(singleRawHeader(request, 'host'), expectedAuthority)) {
    sendError(response, 403, 'invalid_host');
    return;
  }
  if (!request.url?.startsWith('/')) { sendError(response, 400, 'invalid_request'); return; }
  const url = new URL(request.url, `http://${expectedAuthority}`);
  const method = request.method ?? 'GET';
  const mutate = method === 'POST';
  if (mutate && singleRawHeader(request, 'origin') !== `http://${expectedAuthority}`) {
    sendError(response, 403, 'invalid_origin');
    return;
  }
  const guarded = async <T>(key: string, task: () => Promise<T>): Promise<T> => {
    if (active.has(key)) throw new DashboardActionError('operation_in_progress', 409);
    active.add(key);
    try { return await task(); } finally { active.delete(key); }
  };

  if (method === 'GET' && !url.pathname.startsWith('/api/') && await sendStatic(response, url.pathname)) return;
  if (method === 'GET' && url.pathname === '/api/overview') {
    sendValidated(response, 200, dashboardOverviewSchema, await data.overview()); return;
  }
  if (method === 'GET' && url.pathname === '/api/products') {
    sendValidated(response, 200, productsSchema, await data.products()); return;
  }
  if (method === 'GET' && url.pathname === '/api/connection') {
    sendValidated(response, 200, dashboardConnectionSchema, await data.connection()); return;
  }
  if (method === 'GET' && url.pathname === '/api/incidents') {
    const rawStatus = url.searchParams.get('status');
    if (rawStatus && !['open', 'resolved', 'ignored'].includes(rawStatus)) {
      sendError(response, 400, 'invalid_request'); return;
    }
    const status = rawStatus as 'open' | 'resolved' | 'ignored' | null;
    sendValidated(response, 200, incidentsSchema, await data.incidents(status ?? undefined)); return;
  }

  let match = /^\/api\/products\/([^/]+)$/.exec(url.pathname);
  if (method === 'GET' && match) {
    const id = decodedSegment(match[1], productGidSchema);
    if (!id) { sendError(response, 400, 'invalid_identifier'); return; }
    const product = await data.product(id);
    if (!product) { sendError(response, 404, 'not_found'); return; }
    sendValidated(response, 200, dashboardProductDetailSchema, product); return;
  }
  match = /^\/api\/incidents\/([^/]+)$/.exec(url.pathname);
  if (method === 'GET' && match) {
    const id = decodedSegment(match[1], uuidSchema);
    if (!id) { sendError(response, 400, 'invalid_identifier'); return; }
    const incident = await data.incident(id);
    if (!incident) { sendError(response, 404, 'not_found'); return; }
    sendValidated(response, 200, dashboardIncidentDetailSchema, incident); return;
  }
  match = /^\/api\/incidents\/([^/]+)\/evidence\/([^/]+)$/.exec(url.pathname);
  if (method === 'GET' && match) {
    const id = decodedSegment(match[1], uuidSchema);
    const source = decodedSegment(match[2], evidenceSourceSchema);
    if (!id || !source) { sendError(response, 400, 'invalid_identifier'); return; }
    const evidence = await data.incidentEvidence(id, source as EvidenceSourceName);
    if (!evidence) { sendError(response, 404, 'not_found'); return; }
    sendEvidence(response, evidence); return;
  }
  match = /^\/api\/proposals\/([^/]+)$/.exec(url.pathname);
  if (method === 'GET' && match) {
    const id = decodedSegment(match[1], uuidSchema);
    if (!id) { sendError(response, 400, 'invalid_identifier'); return; }
    sendValidated(response, 200, dashboardProposalDetailSchema, await data.proposal(id)); return;
  }

  if (method === 'POST' && url.pathname === '/api/imports') {
    const body = await readJsonBody(request, dashboardImportRequestSchema);
    sendValidated(response, 200, dashboardImportResultSchema, await guarded('import', () => data.importCatalog(body.limit))); return;
  }
  if (method === 'POST' && url.pathname === '/api/monitoring') {
    const body = await readJsonBody(request, dashboardMonitoringRequestSchema);
    sendValidated(response, 200, dashboardMonitoringResultSchema, await data.monitoring(body)); return;
  }
  if (method === 'POST' && url.pathname === '/api/scans') {
    const body = await readJsonBody(request, dashboardScanRequestSchema);
    sendValidated(response, 200, dashboardScanResultSchema, await guarded(`scan:${body.productId}`, () => data.scan(body.productId))); return;
  }
  match = /^\/api\/products\/([^/]+)\/improve$/.exec(url.pathname);
  if (method === 'POST' && match) {
    const id = decodedSegment(match[1], productGidSchema);
    if (!id) { sendError(response, 400, 'invalid_identifier'); return; }
    await readJsonBody(request, dashboardEmptyRequestSchema);
    sendValidated(response, 200, dashboardImproveResultSchema, await data.improve(id)); return;
  }
  match = /^\/api\/incidents\/([^/]+)\/rerun$/.exec(url.pathname);
  if (method === 'POST' && match) {
    const id = decodedSegment(match[1], uuidSchema);
    if (!id) { sendError(response, 400, 'invalid_identifier'); return; }
    await readJsonBody(request, dashboardEmptyRequestSchema);
    sendValidated(response, 200, dashboardRerunResultSchema, await guarded(`rerun:${id}`, () => data.rerun(id))); return;
  }
  match = /^\/api\/proposals\/([^/]+)\/(reject|apply|reconcile|revert)$/.exec(url.pathname);
  if (method === 'POST' && match) {
    const id = decodedSegment(match[1], uuidSchema);
    if (!id) { sendError(response, 400, 'invalid_identifier'); return; }
    const action = match[2]!;
    if (action === 'apply') {
      const body = await readJsonBody(request, dashboardApplyRequestSchema);
      sendValidated(response, 200, dashboardApplyResultSchema, await guarded(`apply:${id}`, () => data.apply(id, body))); return;
    }
    await readJsonBody(request, dashboardEmptyRequestSchema);
    if (action === 'reject') {
      sendValidated(response, 200, dashboardProposalActionResultSchema, await data.reject(id)); return;
    }
    if (action === 'reconcile') {
      sendValidated(response, 200, dashboardProposalActionResultSchema, await guarded(`reconcile:${id}`, () => data.reconcile(id))); return;
    }
    sendValidated(response, 200, dashboardRevertResultSchema, await data.revert(id)); return;
  }

  if (!['GET', 'POST'].includes(method)) {
    response.setHeader('Allow', 'GET, POST');
    sendError(response, 405, 'method_not_allowed');
    return;
  }
  sendError(response, 404, 'not_found');
}

export async function startDashboardServer(
  data: DashboardDataSource,
  options: { port?: number; host?: '127.0.0.1' } = {},
): Promise<DashboardServer> {
  let expectedAuthority = '';
  const active = new Set<string>();
  const server = createServer((request, response) => {
    void routeRequest(request, response, data, expectedAuthority, active).catch(error => {
      if (response.headersSent) { response.destroy(); return; }
      if (error instanceof DashboardActionError) sendError(response, error.status, error.code);
      else sendError(response, 500, 'dashboard_unavailable');
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4173, options.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('Dashboard server did not obtain a loopback port.')); return; }
      expectedAuthority = `127.0.0.1:${address.port}`;
      resolveListen();
    });
  });
  return {
    url: `http://${expectedAuthority}`,
    close: () => new Promise<void>((resolveClose, reject) => {
      server.close(error => error ? reject(error) : resolveClose());
    }),
  };
}
