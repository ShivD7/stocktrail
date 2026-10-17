import { createHash } from 'node:crypto';
import {
  proposalArtifactSchema,
  type ProductContent,
  type ProposalArtifact,
  type ProposalField,
  type ProposalFieldChange,
  type ProposalKind,
  type ProposalSnapshot,
  type ProposalValidation,
  type ProposalValidationCode,
  type ProposalWarningCode,
} from '../../shared/src/proposals.js';
import { readinessScoreSchema, type ReadinessScore } from '../../shared/src/readiness.js';
import {
  scoreInventoryPromiseClarity,
  scoreStaleClaimSafety,
  type AdminContentEvidence,
} from '../../scorer/src/readiness.js';

export const CONTENT_LIMITS = {
  title: 255,
  descriptionBytes: 512 * 1024,
  seoTitle: 70,
  seoDescription: 320,
} as const;

type Block = { start: number; end: number; text: string };
type Edit = { field: ProposalField; start: number; end: number; sourceField?: ProposalField; replacement: string; operation?: 'copy' | 'delete_transient_claim' };

const activeHtml = /<(?:script|style|iframe|object|embed|form|svg|math)\b|\son[a-z]+\s*=/iu;
const broadClaims = [
  /\bin[\s-]+stock[\s-]+(?:right[\s-]+)?now\b/iu,
  /\b(?:(?:only|just)\s+\d{1,4}|\d{1,4}\s+(?:items?|units?))\s+(?:left|remaining|in[\s-]+stock)\b/iu,
  /\b(?:restocks?|back[\s-]+in[\s-]+stock)\s+(?:on|by|within)\b/iu,
  /\b(?:ships?|delivers?|arrives?)\s+(?:today|tomorrow|by|within)\b/iu,
];
const wholeClaims = [
  /^in[\s-]+stock[\s-]+(?:right[\s-]+)?now[.!?]?$/iu,
  /^(?:(?:only|just)\s+\d{1,4}|\d{1,4}\s+(?:items?|units?))\s+(?:left|remaining|in[\s-]+stock)[.!?]?$/iu,
  /^(?:restocks?|back[\s-]+in[\s-]+stock)\s+(?:on|by|within)\s+[^.!?]+[.!?]?$/iu,
  /^(?:ships?|delivers?|arrives?)\s+(?:today|tomorrow|by|within)(?:\s+[^.!?]+)?[.!?]?$/iu,
];

function decodeEntities(value: string): string {
  return value.replace(/&nbsp;/giu, ' ').replace(/&amp;/giu, '&').replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>').replace(/&quot;/giu, '"').replace(/&#39;|&apos;/giu, "'")
    .replace(/&#(\d+);/gu, (entity: string, digits: string) => {
      const point = Number(digits);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point) : entity;
    })
    .replace(/&#x([0-9a-f]+);/giu, (entity: string, digits: string) => {
      const point = Number.parseInt(digits, 16);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point) : entity;
    });
}

function normalizeText(value: string): string {
  return decodeEntities(value).replace(/\s+/gu, ' ').trim();
}

export function containsTransientClaim(value: string): boolean {
  return broadClaims.some(pattern => pattern.test(normalizeText(value)));
}

export function isStandaloneTransientClaim(value: string): boolean {
  const normalized = normalizeText(value);
  return wholeClaims.some(pattern => pattern.test(normalized));
}

export function parseConservativeDescription(html: string): { ok: true; blocks: Block[] } | { ok: false; reason: 'active' | 'shape' | 'unbalanced' } {
  if (activeHtml.test(html)) return { ok: false, reason: 'active' };
  const opening = html.match(/<(?:p|li)(?:\s|>)/giu)?.length ?? 0;
  const closing = html.match(/<\/(?:p|li)>/giu)?.length ?? 0;
  if (opening !== closing) return { ok: false, reason: 'unbalanced' };
  const blocks: Block[] = [];
  const pattern = /<(p|li)>([^<]*)<\/\1>/giu;
  let cursor = 0;
  for (const match of html.matchAll(pattern)) {
    const start = match.index;
    if (start === undefined || html.slice(cursor, start).trim() !== '') return { ok: false, reason: 'shape' };
    const raw = match[0];
    blocks.push({ start, end: start + raw.length, text: normalizeText(match[2] ?? '') });
    cursor = start + raw.length;
  }
  if (html.slice(cursor).trim() !== '' || (html.trim() !== '' && blocks.length === 0)) {
    return { ok: false, reason: 'shape' };
  }
  return { ok: true, blocks };
}

function valueAt(content: ProductContent, field: ProposalField): string | null {
  if (field === 'title') return content.title;
  if (field === 'descriptionHtml') return content.descriptionHtml;
  if (field === 'seo.title') return content.seo.title;
  return content.seo.description;
}

function setValue(content: ProductContent, field: ProposalField, value: string | null): void {
  if (field === 'title') content.title = value ?? '';
  else if (field === 'descriptionHtml') content.descriptionHtml = value ?? '';
  else if (field === 'seo.title') content.seo.title = value;
  else content.seo.description = value;
}

export function hashValue(value: string | null): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

export function contentFingerprint(productId: string, productUpdatedAt: string, content: ProductContent): string {
  return createHash('sha256').update(JSON.stringify({
    productId,
    productUpdatedAt,
    title: content.title,
    descriptionHtml: content.descriptionHtml,
    seoTitle: content.seo.title,
    seoDescription: content.seo.description,
  }), 'utf8').digest('hex');
}

function removeRanges(value: string, edits: Edit[]): string {
  let result = value;
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  }
  return result;
}

function standaloneTextEdits(field: ProposalField, value: string): { edits: Edit[]; mixed: boolean } {
  const edits: Edit[] = [];
  const candidates: Array<{ start: number; end: number; text: string }> = [];
  if (field === 'title' || field === 'seo.title') {
    const delimited = /(?:^|\s+(?:\||—)\s+)([^|—]+)(?=$|\s+(?:\||—)\s+)/gu;
    for (const match of value.matchAll(delimited)) {
      const segment = match[1] ?? '';
      const segmentOffset = (match.index ?? 0) + match[0].lastIndexOf(segment);
      candidates.push({ start: segmentOffset, end: segmentOffset + segment.length, text: segment });
    }
    const parenthetical = /\(([^()]*)\)\s*$/u.exec(value);
    if (parenthetical?.index !== undefined) candidates.push({ start: parenthetical.index, end: value.length, text: parenthetical[1] ?? '' });
  } else {
    const sentence = /[^.!?]+[.!?]+|[^.!?]+$/gu;
    for (const match of value.matchAll(sentence)) candidates.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, text: match[0] });
  }
  for (const candidate of candidates) {
    if (!isStandaloneTransientClaim(candidate.text)) continue;
    let start = candidate.start;
    let end = candidate.end;
    if (field === 'title' || field === 'seo.title') {
      const before = value.slice(0, start);
      const after = value.slice(end);
      const leftDelimiter = /\s+(?:\||—)\s*$/u.exec(before);
      const rightDelimiter = /^\s*(?:\||—)\s+/u.exec(after);
      if (leftDelimiter) start -= leftDelimiter[0].length;
      else if (rightDelimiter) end += rightDelimiter[0].length;
    } else while (end < value.length && /\s/u.test(value[end] ?? '')) end += 1;
    edits.push({ field, start, end, replacement: '' });
  }
  const transformed = removeRanges(value, edits).trim();
  return { edits, mixed: containsTransientClaim(transformed) || (containsTransientClaim(value) && edits.length === 0) };
}

function descriptionEdits(value: string): { edits: Edit[]; mixed: boolean; unsafe: boolean } {
  const parsed = parseConservativeDescription(value);
  if (!parsed.ok) return { edits: [], mixed: containsTransientClaim(value), unsafe: true };
  const edits = parsed.blocks.filter(block => isStandaloneTransientClaim(block.text)).map(block => ({
    field: 'descriptionHtml' as const, start: block.start, end: block.end, replacement: '',
  }));
  return { edits, mixed: containsTransientClaim(removeRanges(value, edits)), unsafe: false };
}

function recomputeReadiness(current: ReadinessScore, snapshot: ProposalSnapshot, content: ProductContent): ReadinessScore {
  const evidence: AdminContentEvidence = {
    title: content.title,
    descriptionHtml: content.descriptionHtml,
    seoTitle: content.seo.title,
    seoDescription: content.seo.description,
    productUpdatedAt: snapshot.productUpdatedAt,
    latestInventoryUpdatedAt: snapshot.latestInventoryUpdatedAt,
  };
  const replacements = new Map([
    ['inventory_promise_clarity', scoreInventoryPromiseClarity(evidence)],
    ['stale_claim_safety', scoreStaleClaimSafety(evidence)],
  ]);
  const components = current.components.map(component => replacements.get(component.id) ?? component);
  const conclusive = components.filter(component => component.points !== null);
  const knownPoints = conclusive.reduce((sum, component) => sum + (component.points ?? 0), 0);
  const knownMax = conclusive.reduce((sum, component) => sum + component.weight, 0);
  return readinessScoreSchema.parse({
    schemaVersion: 1,
    total: conclusive.length === components.length ? knownPoints : null,
    knownPoints,
    knownMax,
    components,
    limitation: current.limitation,
  });
}

function changeFor(field: ProposalField, before: string | null, after: string | null, edits: Edit[], ruleCodes: ProposalFieldChange['ruleCodes']): ProposalFieldChange {
  return {
    field, before, after, beforeHash: hashValue(before), afterHash: hashValue(after), ruleCodes,
    provenance: edits.map(edit => ({
      sourceField: edit.sourceField ?? field,
      operation: edit.operation ?? (edit.replacement === '' ? 'delete_transient_claim' as const : 'copy' as const),
      start: edit.start,
      end: edit.end,
    })),
  };
}

function codePoints(value: string): number { return [...value].length; }

export function validateProposal(
  kind: ProposalKind,
  base: ProposalSnapshot,
  candidate: ProductContent,
  changes: ProposalFieldChange[],
  currentReadiness: ReadinessScore,
  predictedReadiness: ReadinessScore,
): ProposalValidation {
  const reasons = new Set<ProposalValidationCode>();
  const warnings = new Set<ProposalWarningCode>();
  const fields = changes.map(change => change.field);
  const approvedFields = new Set(['title', 'descriptionHtml', 'seo.title', 'seo.description']);
  if (changes.some(change => !approvedFields.has(change.field))) reasons.add('PV_UNAPPROVED_FIELD');
  if (new Set(fields).size !== fields.length) reasons.add('PV_DUPLICATE_FIELD');
  if (changes.length === 0) reasons.add('PV_NO_EFFECT');
  if (base.fingerprint !== contentFingerprint(base.productId, base.productUpdatedAt, base.content)) reasons.add('PV_BASE_EVIDENCE_INVALID');
  if (!base.content.title.trim() || !candidate.title.trim()) reasons.add('PV_EMPTY_TITLE');
  if (codePoints(candidate.title) > CONTENT_LIMITS.title) reasons.add('PV_TITLE_TOO_LONG');
  if (Buffer.byteLength(candidate.descriptionHtml, 'utf8') > CONTENT_LIMITS.descriptionBytes) reasons.add('PV_DESCRIPTION_TOO_LARGE');
  if (candidate.seo.title !== null && codePoints(candidate.seo.title) > CONTENT_LIMITS.seoTitle) reasons.add('PV_SEO_TITLE_TOO_LONG');
  if (candidate.seo.description !== null && codePoints(candidate.seo.description) > CONTENT_LIMITS.seoDescription) reasons.add('PV_SEO_DESCRIPTION_TOO_LONG');
  for (const change of changes) {
    const before = valueAt(base.content, change.field);
    const after = valueAt(candidate, change.field);
    if (hashValue(before) !== change.beforeHash || hashValue(after) !== change.afterHash) reasons.add('PV_ARTIFACT_HASH_MISMATCH');
    if (before !== change.before || after !== change.after) reasons.add('PV_PROVENANCE_REPLAY_FAILED');
    if (before === after) reasons.add('PV_NO_EFFECT');
    if (kind === 'improvement' && (after === null || after.trim() === '')) reasons.add('PV_EMPTY_CHANGED_FIELD');
    if (change.provenance.length === 0) reasons.add('PV_SOURCE_ATTRIBUTION_MISSING');
    const deleteOps = change.provenance.filter(operation => operation.operation === 'delete_transient_claim');
    const copyOps = change.provenance.filter(operation => operation.operation === 'copy');
    if (deleteOps.length > 0) {
      if (typeof before !== 'string' || typeof after !== 'string') reasons.add('PV_PROVENANCE_REPLAY_FAILED');
      else {
        const replay = removeRanges(before, deleteOps.map(operation => ({ field: change.field, start: operation.start, end: operation.end, replacement: '' }))).trim();
        if (replay !== after) { reasons.add('PV_INFORMATION_LOSS'); reasons.add('PV_UNAUTHORIZED_REORDER'); }
        for (const operation of deleteOps) if (!containsTransientClaim(before.slice(operation.start, operation.end))) reasons.add('PV_INFORMATION_LOSS');
      }
    }
    if (copyOps.length > 0) {
      const validCopy = copyOps.some(operation => {
        const source = valueAt(base.content, operation.sourceField);
        if (source === null) return false;
        if (change.ruleCodes.includes('ST-G002_COPY_TITLE_TO_EMPTY_SEO_TITLE')) return after === source.slice(operation.start, operation.end);
        if (change.ruleCodes.includes('ST-G003_COPY_DESCRIPTION_TO_EMPTY_SEO_DESCRIPTION')) {
          const parsed = parseConservativeDescription(source);
          return parsed.ok && parsed.blocks.some(block => block.start === operation.start && block.end === operation.end && after === block.text);
        }
        return false;
      });
      if (!validCopy) reasons.add('PV_UNATTRIBUTED_INSERTION');
    }
  }
  if (changes.some(change => change.field === 'descriptionHtml')) {
    const parsed = parseConservativeDescription(candidate.descriptionHtml);
    if (!parsed.ok) reasons.add(parsed.reason === 'active'
      ? 'PV_ACTIVE_CONTENT_CHANGED'
      : parsed.reason === 'unbalanced' ? 'PV_UNBALANCED_HTML' : 'PV_UNSAFE_HTML_SHAPE');
  }
  const candidateText = [candidate.title, candidate.descriptionHtml, candidate.seo.title, candidate.seo.description]
    .filter((value): value is string => value !== null).join(' ');
  if (containsTransientClaim(candidateText)) {
    if (kind === 'revert') warnings.add('PW_TRANSIENT_CLAIM_REINTRODUCED');
    else reasons.add('PV_TRANSIENT_CLAIM_REMAINS');
  }
  if (predictedReadiness.knownPoints < currentReadiness.knownPoints) {
    if (kind === 'revert') warnings.add('PW_READINESS_REGRESSION');
    else reasons.add('PV_READINESS_REGRESSION');
  }
  return { valid: reasons.size === 0, reasonCodes: [...reasons].sort(), warningCodes: [...warnings].sort() };
}

export type ProposalDraftResult = { proposal: ProposalArtifact | null; guidanceCodes: ProposalValidationCode[] };

export function createImprovementProposal(input: { id: string; createdAt: string; snapshot: ProposalSnapshot; currentReadiness: ReadinessScore }): ProposalDraftResult {
  const candidate: ProductContent = structuredClone(input.snapshot.content);
  const editsByField = new Map<ProposalField, Edit[]>();
  const guidance = new Set<ProposalValidationCode>();
  for (const field of ['title', 'seo.title', 'seo.description'] as const) {
    const value = valueAt(candidate, field);
    if (value === null || value === '') continue;
    const result = standaloneTextEdits(field, value);
    if (result.mixed) guidance.add('PV_UNSAFE_MIXED_CLAIM');
    if (result.edits.length > 0) {
      const transformed = removeRanges(value, result.edits).trim();
      if (transformed) { setValue(candidate, field, transformed); editsByField.set(field, result.edits); }
      else guidance.add('PV_EMPTY_CHANGED_FIELD');
    }
  }
  const description = descriptionEdits(candidate.descriptionHtml);
  if (description.unsafe && containsTransientClaim(candidate.descriptionHtml)) guidance.add('PV_UNSAFE_HTML_SHAPE');
  if (description.mixed) guidance.add('PV_UNSAFE_MIXED_CLAIM');
  if (description.edits.length > 0) {
    const transformed = removeRanges(candidate.descriptionHtml, description.edits).trim();
    if (transformed) { candidate.descriptionHtml = transformed; editsByField.set('descriptionHtml', description.edits); }
    else guidance.add('PV_EMPTY_CHANGED_FIELD');
  }
  const titleSourceStart = input.snapshot.content.title.indexOf(candidate.title);
  const titleSourceUnique = titleSourceStart >= 0 && input.snapshot.content.title.lastIndexOf(candidate.title) === titleSourceStart;
  if ((candidate.seo.title === null || candidate.seo.title.trim() === '') && titleSourceUnique &&
      !containsTransientClaim(candidate.title) && codePoints(candidate.title) <= CONTENT_LIMITS.seoTitle) {
    candidate.seo.title = candidate.title;
    editsByField.set('seo.title', [{
      field: 'seo.title', sourceField: 'title', start: titleSourceStart,
      end: titleSourceStart + candidate.title.length, replacement: candidate.title,
    }]);
  }
  if (candidate.seo.description === null || candidate.seo.description.trim() === '') {
    const parsed = parseConservativeDescription(input.snapshot.content.descriptionHtml);
    const block = parsed.ok ? parsed.blocks.find(value => value.text && !containsTransientClaim(value.text) && codePoints(value.text) <= CONTENT_LIMITS.seoDescription) : undefined;
    if (block) {
      candidate.seo.description = block.text;
      editsByField.set('seo.description', [{ field: 'seo.description', sourceField: 'descriptionHtml', start: block.start, end: block.end, replacement: block.text }]);
    }
  }
  const changes: ProposalFieldChange[] = [];
  for (const [field, edits] of editsByField) {
    const before = valueAt(input.snapshot.content, field);
    const after = valueAt(candidate, field);
    if (before === after) continue;
    const rules = edits[0]?.sourceField === 'title'
      ? ['ST-G002_COPY_TITLE_TO_EMPTY_SEO_TITLE'] as const
      : edits[0]?.sourceField === 'descriptionHtml' && field === 'seo.description'
        ? ['ST-G003_COPY_DESCRIPTION_TO_EMPTY_SEO_DESCRIPTION'] as const
        : ['ST-G001_REMOVE_TRANSIENT_CLAIM'] as const;
    changes.push(changeFor(field, before, after, edits, [...rules]));
  }
  const predicted = recomputeReadiness(input.currentReadiness, input.snapshot, candidate);
  const validation = validateProposal('improvement', input.snapshot, candidate, changes, input.currentReadiness, predicted);
  for (const reason of validation.reasonCodes) guidance.add(reason);
  if (!validation.valid || changes.length === 0) return { proposal: null, guidanceCodes: [...guidance].sort() };
  return { proposal: proposalArtifactSchema.parse({
    schemaVersion: 1, id: input.id, kind: 'improvement', parentProposalId: null,
    productId: input.snapshot.productId, sourceEvidenceRunId: input.snapshot.evidenceRunId,
    base: input.snapshot, candidate, changes, currentReadiness: input.currentReadiness,
    predictedReadiness: predicted, validation, createdAt: input.createdAt,
  }), guidanceCodes: [...guidance].sort() };
}

export function createRevertProposal(input: { id: string; createdAt: string; parent: ProposalArtifact; base: ProposalSnapshot; currentReadiness: ReadinessScore }): ProposalArtifact {
  const candidate = structuredClone(input.base.content);
  const changes: ProposalFieldChange[] = [];
  for (const parentChange of input.parent.changes) {
    const before = valueAt(input.base.content, parentChange.field);
    const after = parentChange.before;
    if (before === after) continue;
    setValue(candidate, parentChange.field, after);
    const source = valueAt(input.parent.base.content, parentChange.field) ?? '';
    changes.push(changeFor(parentChange.field, before, after, [{ field: parentChange.field, sourceField: parentChange.field, start: 0, end: source.length, replacement: source, operation: 'copy' }], parentChange.ruleCodes));
  }
  const predicted = recomputeReadiness(input.currentReadiness, input.base, candidate);
  let validation = validateProposal('revert', input.base, candidate, changes, input.currentReadiness, predicted);
  validation = { ...validation, reasonCodes: validation.reasonCodes.filter(code => code !== 'PV_UNATTRIBUTED_INSERTION') };
  validation.valid = validation.reasonCodes.length === 0;
  return proposalArtifactSchema.parse({
    schemaVersion: 1, id: input.id, kind: 'revert', parentProposalId: input.parent.id,
    productId: input.base.productId, sourceEvidenceRunId: input.base.evidenceRunId,
    base: input.base, candidate, changes, currentReadiness: input.currentReadiness,
    predictedReadiness: predicted, validation, createdAt: input.createdAt,
  });
}

export type DiffPart = { kind: 'equal' | 'remove' | 'add'; value: string };
export type FieldDiff = { field: ProposalField; mode: 'word' | 'line'; parts: DiffPart[]; truncated: boolean };

function lcsDiff(before: string[], after: string[], maximum: number): { parts: DiffPart[]; truncated: boolean } {
  if (before.length > maximum || after.length > maximum || before.length * after.length > 250_000) {
    return { parts: [{ kind: 'remove', value: before.join('') }, { kind: 'add', value: after.join('') }], truncated: true };
  }
  const table = Array.from({ length: before.length + 1 }, () => new Uint16Array(after.length + 1));
  for (let left = before.length - 1; left >= 0; left -= 1) for (let right = after.length - 1; right >= 0; right -= 1) {
    table[left]![right] = before[left] === after[right]
      ? (table[left + 1]![right + 1] ?? 0) + 1
      : Math.max(table[left + 1]![right] ?? 0, table[left]![right + 1] ?? 0);
  }
  const parts: DiffPart[] = [];
  const push = (kind: DiffPart['kind'], value: string) => {
    const previous = parts.at(-1);
    if (previous?.kind === kind) previous.value += value;
    else parts.push({ kind, value });
  };
  let left = 0; let right = 0;
  while (left < before.length && right < after.length) {
    if (before[left] === after[right]) { push('equal', before[left] ?? ''); left += 1; right += 1; }
    else if ((table[left + 1]![right] ?? 0) >= (table[left]![right + 1] ?? 0)) { push('remove', before[left] ?? ''); left += 1; }
    else { push('add', after[right] ?? ''); right += 1; }
  }
  while (left < before.length) { push('remove', before[left] ?? ''); left += 1; }
  while (right < after.length) { push('add', after[right] ?? ''); right += 1; }
  return { parts, truncated: false };
}

export function createFieldDiffs(changes: ProposalFieldChange[]): FieldDiff[] {
  return changes.map(change => {
    const before = change.before ?? '';
    const after = change.after ?? '';
    const mode = change.field === 'descriptionHtml' ? 'line' as const : 'word' as const;
    const tokenize = mode === 'line'
      ? (value: string) => value.match(/.*(?:\r\n|\n|\r)|.+$/gu) ?? []
      : (value: string) => value.match(/\s+|[^\s]+/gu) ?? [];
    const diff = lcsDiff(tokenize(before), tokenize(after), mode === 'line' ? 1_000 : 2_000);
    return { field: change.field, mode, ...diff };
  });
}
