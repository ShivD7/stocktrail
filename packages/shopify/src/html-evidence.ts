import type { BundleReasonCode, JsonLdClaim } from '../../shared/src/evidence-bundle.js';

const MAX_JSONLD_BLOCKS = 64;
const MAX_JSONLD_BLOCK_BYTES = 512 * 1024;
const MAX_JSONLD_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 10_000;
const MAX_TAG_BYTES = 64 * 1024;

export type HtmlExtraction = {
  canonicalHref: string | null;
  blocks: string[];
  reasonCode: 'html_budget_exceeded' | null;
};

export type JsonLdBlockResult = {
  index: number;
  status: 'valid' | 'malformed' | 'budget_exceeded';
  text: string;
};

export type JsonLdNormalization = {
  reasonCode: BundleReasonCode | null;
  blocks: JsonLdBlockResult[];
  claims: JsonLdClaim[];
  validBlockCount: number;
};

type ParsedTag = {
  end: number;
  name: string;
  closing: boolean;
  attributes: Map<string, string>;
};

function parseAttributes(value: string, offset: number): Map<string, string> {
  const attributes = new Map<string, string>();
  let index = offset;
  while (index < value.length) {
    while (/\s|\//.test(value[index] ?? '')) index += 1;
    if (index >= value.length) break;
    const start = index;
    while (index < value.length && !/[\s=/>]/.test(value[index]!)) index += 1;
    if (index === start) { index += 1; continue; }
    const name = value.slice(start, index).toLowerCase();
    while (/\s/.test(value[index] ?? '')) index += 1;
    let attributeValue = '';
    if (value[index] === '=') {
      index += 1;
      while (/\s/.test(value[index] ?? '')) index += 1;
      const quote = value[index];
      if (quote === '"' || quote === "'") {
        index += 1;
        const valueStart = index;
        while (index < value.length && value[index] !== quote) index += 1;
        attributeValue = value.slice(valueStart, index);
        if (index < value.length) index += 1;
      } else {
        const valueStart = index;
        while (index < value.length && !/[\s>]/.test(value[index]!)) index += 1;
        attributeValue = value.slice(valueStart, index);
      }
    }
    if (!attributes.has(name)) attributes.set(name, attributeValue);
  }
  return attributes;
}

function parseTag(html: string, start: number): ParsedTag | null {
  let index = start + 1;
  let quote: string | null = null;
  while (index < html.length && index - start <= MAX_TAG_BYTES) {
    const character = html[index]!;
    if (quote !== null) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '>') break;
    index += 1;
  }
  if (index >= html.length || index - start > MAX_TAG_BYTES) return null;
  const inside = html.slice(start + 1, index);
  let cursor = 0;
  while (/\s/.test(inside[cursor] ?? '')) cursor += 1;
  const closing = inside[cursor] === '/';
  if (closing) cursor += 1;
  while (/\s/.test(inside[cursor] ?? '')) cursor += 1;
  const nameStart = cursor;
  while (/[A-Za-z0-9:-]/.test(inside[cursor] ?? '')) cursor += 1;
  if (cursor === nameStart) return { end: index + 1, name: '', closing, attributes: new Map() };
  return {
    end: index + 1,
    name: inside.slice(nameStart, cursor).toLowerCase(),
    closing,
    attributes: parseAttributes(inside, cursor),
  };
}

function findClosingScript(html: string, start: number): { contentEnd: number; end: number } | null {
  let index = start;
  while (index < html.length) {
    const candidate = html.indexOf('<', index);
    if (candidate < 0) return null;
    const tag = parseTag(html, candidate);
    if (tag?.closing && tag.name === 'script') return { contentEnd: candidate, end: tag.end };
    index = candidate + 1;
  }
  return null;
}

export function extractHtmlEvidence(html: string): HtmlExtraction {
  const blocks: string[] = [];
  let totalBytes = 0;
  let canonicalHref: string | null = null;
  let inHead = false;
  let index = 0;
  while (index < html.length) {
    const start = html.indexOf('<', index);
    if (start < 0) break;
    if (html.startsWith('<!--', start)) {
      const commentEnd = html.indexOf('-->', start + 4);
      if (commentEnd < 0) return { canonicalHref, blocks, reasonCode: 'html_budget_exceeded' };
      index = commentEnd + 3;
      continue;
    }
    const tag = parseTag(html, start);
    if (tag === null) return { canonicalHref, blocks, reasonCode: 'html_budget_exceeded' };
    index = tag.end;
    if (tag.name === 'head') inHead = !tag.closing;
    if (!tag.closing && inHead && tag.name === 'link' && canonicalHref === null) {
      const rel = tag.attributes.get('rel')?.toLowerCase().split(/\s+/) ?? [];
      if (rel.includes('canonical') && tag.attributes.has('href')) {
        canonicalHref = tag.attributes.get('href') ?? null;
      }
    }
    if (!tag.closing && tag.name === 'script') {
      const close = findClosingScript(html, tag.end);
      if (close === null) return { canonicalHref, blocks, reasonCode: 'html_budget_exceeded' };
      const type = tag.attributes.get('type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (type === 'application/ld+json' && !tag.attributes.has('src')) {
        const text = html.slice(tag.end, close.contentEnd);
        const bytes = Buffer.byteLength(text, 'utf8');
        if (blocks.length >= MAX_JSONLD_BLOCKS || bytes > MAX_JSONLD_BLOCK_BYTES ||
            totalBytes + bytes > MAX_JSONLD_TOTAL_BYTES) {
          return { canonicalHref, blocks, reasonCode: 'html_budget_exceeded' };
        }
        blocks.push(text);
        totalBytes += bytes;
      }
      index = close.end;
    }
  }
  return { canonicalHref, blocks, reasonCode: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scalar(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function supportedKind(value: unknown): JsonLdClaim['kind'] | null {
  const values = Array.isArray(value) ? value : [value];
  for (const candidate of values) {
    if (typeof candidate !== 'string') continue;
    const tail = candidate.split(/[\/#]/).filter(Boolean).at(-1);
    if (tail === 'Product' || tail === 'ProductGroup' || tail === 'Offer' || tail === 'AggregateOffer') return tail;
  }
  return null;
}

function referenceId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  return isRecord(value) ? scalar(value['@id']) ?? scalar(value.url) : null;
}

function valuesOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function exactVariantId(urlValue: string | null, legacyIds: Set<string>): string | null {
  if (urlValue === null) return null;
  try {
    const url = new URL(urlValue, 'https://stocktrail.invalid/');
    const candidates = url.searchParams.getAll('variant');
    if (candidates.length !== 1 || !/^(0|[1-9]\d*)$/.test(candidates[0]!)) return null;
    return legacyIds.has(candidates[0]!) ? candidates[0]! : null;
  } catch {
    return null;
  }
}

function normalizeAvailability(value: string | null): string | null {
  return value?.split(/[\/#]/).filter(Boolean).at(-1) ?? null;
}

export function normalizeJsonLd(blockTexts: string[], adminLegacyIds: string[]): JsonLdNormalization {
  const blocks: JsonLdBlockResult[] = [];
  const claims: JsonLdClaim[] = [];
  const legacyIds = new Set(adminLegacyIds);
  let malformed = false;
  let budgetExceeded = false;
  for (const [blockIndex, text] of blockTexts.entries()) {
    let root: unknown;
    try {
      root = JSON.parse(text);
    } catch {
      malformed = true;
      blocks.push({ index: blockIndex, status: 'malformed', text });
      continue;
    }
    const entries: Array<{ object: Record<string, unknown>; path: string }> = [];
    let nodeCount = 0;
    let blockBudgetExceeded = false;
    const walk = (value: unknown, path: string, depth: number): void => {
      nodeCount += 1;
      if (depth > MAX_JSON_DEPTH || nodeCount > MAX_JSON_NODES) {
        blockBudgetExceeded = true;
        return;
      }
      if (Array.isArray(value)) {
        for (const [index, child] of value.entries()) {
          if (blockBudgetExceeded) break;
          walk(child, `${path}[${index}]`, depth + 1);
        }
      } else if (isRecord(value)) {
        entries.push({ object: value, path });
        for (const [key, child] of Object.entries(value)) {
          if (blockBudgetExceeded) break;
          walk(child, `${path}.${key}`, depth + 1);
        }
      }
    };
    walk(root, '$', 0);
    if (blockBudgetExceeded) {
      budgetExceeded = true;
      blocks.push({ index: blockIndex, status: 'budget_exceeded', text });
      continue;
    }
    blocks.push({ index: blockIndex, status: 'valid', text });
    const parentHints = new Map<Record<string, unknown>, string>();
    const idMap = new Map<string, Record<string, unknown>>();
    for (const { object } of entries) {
      const id = scalar(object['@id']);
      if (id !== null && (!idMap.has(id) || supportedKind(object['@type']) !== null)) idMap.set(id, object);
    }
    const resolveRelationship = (value: unknown): Record<string, unknown> | null => {
      const id = referenceId(value);
      if (id !== null && idMap.has(id)) return idMap.get(id)!;
      return isRecord(value) ? value : null;
    };
    for (const { object } of entries) {
      const kind = supportedKind(object['@type']);
      const owner = scalar(object['@id']) ?? scalar(object.url);
      const relationships = kind === 'ProductGroup' ? valuesOf(object.hasVariant)
        : kind === 'Product' || kind === 'AggregateOffer' ? valuesOf(object.offers)
          : [];
      if (owner !== null) {
        for (const child of relationships) {
          const resolved = resolveRelationship(child);
          if (resolved !== null) parentHints.set(resolved, owner);
        }
      }
    }
    for (const { object, path } of entries) {
      const kind = supportedKind(object['@type']);
      if (kind === null) continue;
      const url = scalar(object.url) ?? (kind === 'Offer' ? scalar(object['@id']) : null);
      const availabilityRaw = scalar(object.availability);
      const variesBy = valuesOf(object.variesBy).map(scalar).filter((value): value is string => value !== null);
      const parent = kind === 'Product' ? referenceId(object.isVariantOf)
        : kind === 'Offer' ? referenceId(object.itemOffered) ?? parentHints.get(object) ?? null
          : parentHints.get(object) ?? null;
      const urlVariantId = (() => {
        if (url === null) return null;
        try {
          const candidates = new URL(url, 'https://stocktrail.invalid/').searchParams.getAll('variant');
          return candidates.length === 1 && /^(0|[1-9]\d*)$/.test(candidates[0]!) ? candidates[0]! : null;
        } catch { return null; }
      })();
      claims.push({
        blockIndex, path, kind,
        id: scalar(object['@id']), url, sku: scalar(object.sku),
        gtin: scalar(object.gtin) ?? scalar(object.gtin14) ?? scalar(object.gtin13) ??
          scalar(object.gtin12) ?? scalar(object.gtin8),
        mpn: scalar(object.mpn), productGroupId: scalar(object.productGroupID) ?? scalar(object.productGroupId),
        variesBy, price: scalar(object.price) ?? scalar(object.lowPrice) ?? scalar(object.highPrice),
        currency: scalar(object.priceCurrency), availabilityRaw,
        availabilityCanonical: normalizeAvailability(availabilityRaw), parent, urlVariantId,
        matchedLegacyVariantId: exactVariantId(url, legacyIds),
      });
    }
  }
  return {
    reasonCode: budgetExceeded ? 'jsonld_budget_exceeded' : malformed ? 'malformed_jsonld' : null,
    blocks,
    claims,
    validBlockCount: blocks.filter(block => block.status === 'valid').length,
  };
}
