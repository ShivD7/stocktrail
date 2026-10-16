import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import type {
  AjaxNormalizedProduct,
  AjaxReasonCode,
} from '../../shared/src/ajax-evidence.js';
import {
  parseLosslessJson,
  type LosslessJson,
  type LosslessNumber,
} from './lossless-json.js';

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_UNSIGNED_64 = 18_446_744_073_709_551_615n;
const OBSERVATION_TIMEOUT_MS = 15_000;

export type DerivedAjaxTarget = {
  url: URL;
  handle: string;
  localePath: string | null;
};

export type ResolvedAddress = { address: string; family: 4 | 6 };

type RawResponse = {
  status: number;
  contentType: string | null;
  contentEncoding: string | null;
  body: Uint8Array;
};

type RawRequestResult =
  | { ok: true; response: RawResponse }
  | { ok: false; reasonCode: 'timeout' | 'transport_failure' | 'body_too_large' };

export type AjaxFetchResult = {
  reasonCode: AjaxReasonCode | null;
  status: number | null;
  contentType: string | null;
  redirectObserved: boolean;
  sha256: string | null;
  byteCount: number | null;
  body: Uint8Array | null;
};

export type AjaxTransportDependencies = {
  resolve(hostname: string, signal: AbortSignal): Promise<ResolvedAddress[]>;
  request(
    target: DerivedAjaxTarget,
    address: ResolvedAddress,
    context: { signal: AbortSignal; timeoutMs: number },
  ): Promise<RawRequestResult>;
  observationTimeoutMs?: number;
  now?: () => number;
};

export class InvalidAjaxProductUrlError extends Error {}

function deriveProductTarget(onlineStoreUrl: string): DerivedAjaxTarget {
  let url: URL;
  try {
    url = new URL(onlineStoreUrl);
  } catch {
    throw new InvalidAjaxProductUrlError('The Admin online store URL is not safe for Ajax observation.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port) {
    throw new InvalidAjaxProductUrlError('The Admin online store URL is not safe for Ajax observation.');
  }
  const hostnameForIpCheck = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  if (!url.hostname || isIP(hostnameForIpCheck) !== 0) {
    throw new InvalidAjaxProductUrlError('The Admin online store URL is not safe for Ajax observation.');
  }
  const segments = url.pathname.split('/').slice(1);
  if (segments.length < 2 || segments.some(segment => !/^[A-Za-z0-9_-]+$/.test(segment))) {
    throw new InvalidAjaxProductUrlError('The Admin online store URL is not safe for Ajax observation.');
  }
  const productIndexes = segments
    .map((segment, index) => segment === 'products' ? index : -1)
    .filter(index => index >= 0);
  const productIndex = productIndexes[0];
  if (productIndexes.length !== 1 || productIndex !== segments.length - 2) {
    throw new InvalidAjaxProductUrlError('The Admin online store URL is not safe for Ajax observation.');
  }
  const handle = segments[segments.length - 1]!;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(handle)) {
    throw new InvalidAjaxProductUrlError('The Admin online store URL is not safe for Ajax observation.');
  }
  const prefix = segments.slice(0, productIndex);
  return {
    url,
    handle,
    localePath: prefix.length === 0 ? null : `/${prefix.join('/')}`,
  };
}

export function deriveHtmlProductTarget(onlineStoreUrl: string): DerivedAjaxTarget {
  return deriveProductTarget(onlineStoreUrl);
}

export function deriveAjaxProductTarget(onlineStoreUrl: string): DerivedAjaxTarget {
  const target = deriveProductTarget(onlineStoreUrl);
  target.url.pathname = `${target.url.pathname}.js`;
  return target;
}

function ipv4Number(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map(part => Number(part));
  if (bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) return null;
  return (((bytes[0]! << 24) >>> 0) + (bytes[1]! << 16) + (bytes[2]! << 8) + bytes[3]!) >>> 0;
}

function inIpv4Range(value: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

function isPublicIpv4(address: string): boolean {
  const value = ipv4Number(address);
  if (value === null) return false;
  const blocked: Array<[number, number]> = [
    [0x0000_0000, 8], [0x0a00_0000, 8], [0x6440_0000, 10], [0x7f00_0000, 8],
    [0xa9fe_0000, 16], [0xac10_0000, 12], [0xc000_0000, 24], [0xc000_0200, 24],
    [0xc058_6300, 24], [0xc0a8_0000, 16], [0xc612_0000, 15], [0xc633_6400, 24],
    [0xcb00_7100, 24], [0xe000_0000, 4], [0xf000_0000, 4],
  ];
  return !blocked.some(([base, prefix]) => inIpv4Range(value, base, prefix));
}

function ipv6Number(address: string): bigint | null {
  let normalized = address.toLowerCase();
  if (normalized.includes('%')) return null;
  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    const ipv4 = ipv4Number(normalized.slice(lastColon + 1));
    if (lastColon < 0 || ipv4 === null) return null;
    normalized = `${normalized.slice(0, lastColon)}:${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (groups.length !== 8 || groups.some(group => !/^[a-f0-9]{1,4}$/.test(group))) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function inIpv6Range(value: bigint, base: bigint, prefix: number): boolean {
  const shift = BigInt(128 - prefix);
  return (value >> shift) === (base >> shift);
}

type Ipv6Prefix = readonly [address: string, length: number];

// Static snapshots of IANA's IPv6 Global Unicast Address Space (2025-10-10)
// and IPv6 Special-Purpose Address Space (2025-10-09); unlisted space is reserved and denied.
const IANA_ALLOCATED_IPV6_PREFIXES: readonly Ipv6Prefix[] = [
  ['2001::', 23], ['2001:200::', 23], ['2001:400::', 23], ['2001:600::', 23],
  ['2001:800::', 22], ['2001:c00::', 23], ['2001:e00::', 23], ['2001:1200::', 23],
  ['2001:1400::', 22], ['2001:1800::', 23], ['2001:1a00::', 23], ['2001:1c00::', 22],
  ['2001:2000::', 19], ['2001:4000::', 23], ['2001:4200::', 23], ['2001:4400::', 23],
  ['2001:4600::', 23], ['2001:4800::', 23], ['2001:4a00::', 23], ['2001:4c00::', 23],
  ['2001:5000::', 20], ['2001:8000::', 19], ['2001:a000::', 20], ['2001:b000::', 20],
  ['2002::', 16], ['2003::', 18], ['2400::', 12], ['2410::', 12],
  ['2600::', 12], ['2610::', 23], ['2620::', 23], ['2630::', 12],
  ['2800::', 12], ['2a00::', 12], ['2a10::', 12], ['2c00::', 12],
];

const IANA_SPECIAL_IPV6_PREFIXES: readonly Ipv6Prefix[] = [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['2620:4f:8000::', 48],
  ['3fff::', 20],
];

function isInIpv6Prefixes(value: bigint, prefixes: readonly Ipv6Prefix[]): boolean {
  return prefixes.some(([address, prefix]) => {
    const base = ipv6Number(address);
    return base !== null && inIpv6Range(value, base, prefix);
  });
}

function isPublicIpv6(address: string): boolean {
  const value = ipv6Number(address);
  if (value === null) return false;
  const mappedPrefix = 0xffffn;
  if ((value >> 32n) === mappedPrefix) return false;
  return isInIpv6Prefixes(value, IANA_ALLOCATED_IPV6_PREFIXES) &&
    !isInIpv6Prefixes(value, IANA_SPECIAL_IPV6_PREFIXES);
}

export function isPublicNetworkAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? isPublicIpv4(address) : family === 6 ? isPublicIpv6(address) : false;
}

export function createPinnedLookup(expectedHostname: string, address: ResolvedAddress) {
  return (
    hostname: string,
    options: { all?: boolean } | number | undefined,
    callback: (...args: unknown[]) => void,
  ): void => {
    if (hostname !== expectedHostname) {
      callback(new Error('Pinned hostname mismatch.'));
      return;
    }
    if (typeof options === 'object' && options?.all === true) {
      callback(null, [{ address: address.address, family: address.family }]);
    } else {
      callback(null, address.address, address.family);
    }
  };
}

export function buildPinnedRequestOptions(target: DerivedAjaxTarget, address: ResolvedAddress): RequestOptions {
  return {
    method: 'GET',
    agent: false,
    servername: target.url.hostname,
    rejectUnauthorized: true,
    lookup: createPinnedLookup(target.url.hostname, address) as RequestOptions['lookup'],
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'identity',
    },
  };
}

function defaultRequest(
  target: DerivedAjaxTarget,
  address: ResolvedAddress,
  context: { signal: AbortSignal; timeoutMs: number },
): Promise<RawRequestResult> {
  return new Promise(resolve => {
    let settled = false;
    let request: ReturnType<typeof httpsRequest> | undefined;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (result: RawRequestResult) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      context.signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => {
      const activeRequest = request;
      finish({ ok: false, reasonCode: 'timeout' });
      activeRequest?.destroy();
    };
    if (context.signal.aborted || context.timeoutMs <= 0) {
      finish({ ok: false, reasonCode: 'timeout' });
      return;
    }
    context.signal.addEventListener('abort', onAbort, { once: true });
    const options = buildPinnedRequestOptions(target, address);
    try {
      request = httpsRequest(target.url, options, response => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > MAX_BODY_BYTES) {
            response.destroy();
            finish({ ok: false, reasonCode: 'body_too_large' });
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const contentType = Array.isArray(response.headers['content-type'])
            ? response.headers['content-type'][0] ?? null
            : response.headers['content-type'] ?? null;
          const contentEncoding = Array.isArray(response.headers['content-encoding'])
            ? response.headers['content-encoding'][0] ?? null
            : response.headers['content-encoding'] ?? null;
          finish({
            ok: true,
            response: {
              status: response.statusCode ?? 0,
              contentType,
              contentEncoding,
              body: Buffer.concat(chunks),
            },
          });
        });
        response.on('error', () => finish({ ok: false, reasonCode: 'transport_failure' }));
      });
    } catch {
      finish({ ok: false, reasonCode: 'transport_failure' });
      return;
    }
    timeout = setTimeout(onAbort, Math.max(1, Math.ceil(context.timeoutMs)));
    timeout.unref();
    request.on('error', () => finish({
      ok: false,
      reasonCode: context.signal.aborted ? 'timeout' : 'transport_failure',
    }));
    request.end();
  });
}

const defaultDependencies: AjaxTransportDependencies = {
  async resolve(hostname) {
    const results = await lookup(hostname, { all: true, verbatim: true });
    return results
      .filter((result): result is { address: string; family: 4 | 6 } => result.family === 4 || result.family === 6)
      .map(result => ({ address: result.address, family: result.family }));
  },
  request: defaultRequest,
};

function mediaType(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.split(';', 1)[0]!.trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalized) && normalized.length <= 100
    ? normalized
    : null;
}

function decodeBody(body: Uint8Array, encodingInput: string | null): { body?: Uint8Array; reasonCode?: AjaxReasonCode } {
  const encoding = encodingInput?.trim().toLowerCase() ?? 'identity';
  try {
    if (encoding === '' || encoding === 'identity') return { body };
    const options = { maxOutputLength: MAX_BODY_BYTES + 1 };
    let decoded: Buffer;
    if (encoding === 'gzip') decoded = gunzipSync(body, options);
    else if (encoding === 'deflate') decoded = inflateSync(body, options);
    else if (encoding === 'br') decoded = brotliDecompressSync(body, options);
    else return { reasonCode: 'unsupported_content_encoding' };
    if (decoded.length > MAX_BODY_BYTES) return { reasonCode: 'body_too_large' };
    return { body: decoded };
  } catch (error) {
    return {
      reasonCode: (error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE'
        ? 'body_too_large'
        : 'body_decode_failed',
    };
  }
}

class ObservationDeadlineError extends Error {}

function waitForObservation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ObservationDeadlineError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new ObservationDeadlineError());
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      value => { cleanup(); resolve(value); },
      error => { cleanup(); reject(error); },
    );
  });
}

async function fetchPublicProduct(
  target: DerivedAjaxTarget,
  expected: 'json' | 'html',
  dependencies: AjaxTransportDependencies,
): Promise<AjaxFetchResult> {
  const now = dependencies.now ?? Date.now;
  const timeoutMs = dependencies.observationTimeoutMs ?? OBSERVATION_TIMEOUT_MS;
  const startedAt = now();
  const deadlineAt = startedAt + timeoutMs;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(0, timeoutMs));
  timeout.unref();
  const expired = () => controller.signal.aborted || now() >= deadlineAt;
  try {
    let addresses: ResolvedAddress[];
    try {
      addresses = await waitForObservation(
        Promise.resolve(dependencies.resolve(target.url.hostname, controller.signal)),
        controller.signal,
      );
    } catch (error) {
      return emptyFetchResult(error instanceof ObservationDeadlineError || expired()
        ? 'timeout'
        : 'dns_resolution_failed');
    }
    if (expired()) return emptyFetchResult('timeout');
    if (addresses.length === 0) return emptyFetchResult('dns_resolution_failed');
    if (addresses.some(address => isIP(address.address) !== address.family || !isPublicNetworkAddress(address.address))) {
      return emptyFetchResult('unsafe_network_address');
    }
    const remainingMs = deadlineAt - now();
    if (remainingMs <= 0) return emptyFetchResult('timeout');
    let requested: RawRequestResult;
    try {
      requested = await waitForObservation(
        Promise.resolve(dependencies.request(
          target,
          addresses[0]!,
          { signal: controller.signal, timeoutMs: remainingMs },
        )),
        controller.signal,
      );
    } catch (error) {
      return emptyFetchResult(error instanceof ObservationDeadlineError || expired()
        ? 'timeout'
        : 'transport_failure');
    }
    if (expired()) return emptyFetchResult('timeout');
    if (!requested.ok) return emptyFetchResult(requested.reasonCode);
    const { response } = requested;
    if (response.body.length > MAX_BODY_BYTES) return emptyFetchResult('body_too_large');
    const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
      ? response.status
      : null;
    if (status === null) return emptyFetchResult('http_status');
    const contentType = mediaType(response.contentType);
    const redirectObserved = status >= 300 && status < 400;
    if (redirectObserved) {
      return { ...emptyFetchResult('redirect_observed'), status, contentType, redirectObserved: true };
    }
    if (status === 401 || status === 403) {
      return { ...emptyFetchResult('http_unauthorized'), status, contentType };
    }
    if (status === 404) return { ...emptyFetchResult('http_not_found'), status: 404, contentType };
    if ((expected === 'html' && status !== 200) || status < 200 || status >= 300) {
      return { ...emptyFetchResult('http_status'), status, contentType };
    }
    if (expected === 'json' &&
        (contentType === null || !(contentType === 'application/json' || contentType.endsWith('+json')))) {
      return { ...emptyFetchResult('non_json_content_type'), status, contentType };
    }
    if (expected === 'html' && contentType !== 'text/html') {
      return { ...emptyFetchResult('non_html_content_type'), status, contentType };
    }
    if (expected === 'html') {
      const charset = response.contentType?.match(/(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/i)?.[1]?.toLowerCase();
      if (charset !== undefined && !['utf-8', 'utf8', 'us-ascii', 'ascii'].includes(charset)) {
        return { ...emptyFetchResult('unsupported_charset'), status, contentType };
      }
    }
    const decoded = decodeBody(response.body, response.contentEncoding);
    if (expired()) return emptyFetchResult('timeout');
    if (decoded.reasonCode !== undefined || decoded.body === undefined) {
      return { ...emptyFetchResult(decoded.reasonCode ?? 'body_decode_failed'), status, contentType };
    }
    const bytes = decoded.body;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (expired()) return emptyFetchResult('timeout');
    return {
      reasonCode: null,
      status,
      contentType,
      redirectObserved: false,
      sha256,
      byteCount: bytes.length,
      body: bytes,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function fetchAjaxProduct(
  target: DerivedAjaxTarget,
  dependencies: AjaxTransportDependencies = defaultDependencies,
): Promise<AjaxFetchResult> {
  return fetchPublicProduct(target, 'json', dependencies);
}

export function fetchHtmlProduct(
  target: DerivedAjaxTarget,
  dependencies: AjaxTransportDependencies = defaultDependencies,
): Promise<AjaxFetchResult> {
  return fetchPublicProduct(target, 'html', dependencies);
}

export function decodeHtmlBody(body: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return null;
  }
}

function emptyFetchResult(reasonCode: AjaxReasonCode): AjaxFetchResult {
  return {
    reasonCode,
    status: null,
    contentType: null,
    redirectObserved: false,
    sha256: null,
    byteCount: null,
    body: null,
  };
}

declare const losslessObjectBrand: unique symbol;
type LosslessObject = { [key: string]: LosslessJson } & { [losslessObjectBrand]: true };

function isObject(value: LosslessJson | undefined): value is LosslessObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !('kind' in value);
}

function decimalId(value: LosslessJson | undefined): string | null {
  const raw = typeof value === 'object' && value !== null && !Array.isArray(value) && 'kind' in value
    ? (value as LosslessNumber).raw
    : typeof value === 'string' ? value : null;
  if (raw === null || !/^(0|[1-9]\d*)$/.test(raw)) return null;
  try {
    if (BigInt(raw) > MAX_UNSIGNED_64) return null;
  } catch {
    return null;
  }
  return raw;
}

function optionalBoolean(object: { [key: string]: LosslessJson }, key: string): boolean | null | undefined {
  if (!(key in object)) return null;
  const value = object[key];
  return typeof value === 'boolean' ? value : undefined;
}

export function normalizeAjaxProduct(body: Uint8Array):
  | { ok: true; product: AjaxNormalizedProduct }
  | { ok: false; reasonCode: AjaxReasonCode } {
  let root: LosslessJson;
  try {
    root = parseLosslessJson(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return { ok: false, reasonCode: 'malformed_json' };
  }
  if (!isObject(root)) return { ok: false, reasonCode: 'malformed_ajax_contract' };
  const id = decimalId(root.id);
  const handle = root.handle;
  const available = optionalBoolean(root, 'available');
  const requiresSellingPlan = optionalBoolean(root, 'requires_selling_plan');
  if (id === null || typeof handle !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(handle) ||
      available === undefined || requiresSellingPlan === undefined || !Array.isArray(root.variants)) {
    return { ok: false, reasonCode: 'malformed_ajax_contract' };
  }
  if (root.variants.length > 250) return { ok: false, reasonCode: 'variant_limit_exceeded' };
  const variants: AjaxNormalizedProduct['variants'] = [];
  const seen = new Set<string>();
  for (const value of root.variants) {
    if (!isObject(value)) return { ok: false, reasonCode: 'malformed_ajax_contract' };
    const variantId = decimalId(value.id);
    const variantAvailable = optionalBoolean(value, 'available');
    const variantRequiresPlan = optionalBoolean(value, 'requires_selling_plan');
    const inventoryManagement = 'inventory_management' in value ? value.inventory_management : null;
    if (variantId === null || variantAvailable === undefined || variantRequiresPlan === undefined ||
        (inventoryManagement !== null && typeof inventoryManagement !== 'string')) {
      return { ok: false, reasonCode: 'malformed_ajax_contract' };
    }
    if (seen.has(variantId)) return { ok: false, reasonCode: 'duplicate_ajax_variant_id' };
    seen.add(variantId);
    const allocationsValue = 'selling_plan_allocations' in value ? value.selling_plan_allocations : [];
    if (!Array.isArray(allocationsValue)) return { ok: false, reasonCode: 'malformed_ajax_contract' };
    const sellingPlanAllocations: AjaxNormalizedProduct['variants'][number]['sellingPlanAllocations'] = [];
    for (const allocationValue of allocationsValue) {
      if (!isObject(allocationValue)) return { ok: false, reasonCode: 'malformed_ajax_contract' };
      const sellingPlanId = decimalId(allocationValue.selling_plan_id);
      const sellingPlanGroupId = decimalId(allocationValue.selling_plan_group_id);
      if (sellingPlanId === null || sellingPlanGroupId === null) {
        return { ok: false, reasonCode: 'malformed_ajax_contract' };
      }
      sellingPlanAllocations.push({ sellingPlanId, sellingPlanGroupId });
    }
    variants.push({
      id: variantId,
      available: variantAvailable,
      inventoryManagement,
      requiresSellingPlan: variantRequiresPlan,
      sellingPlanAllocations,
    });
  }
  return {
    ok: true,
    product: { id, handle, available, requiresSellingPlan, variants },
  };
}
