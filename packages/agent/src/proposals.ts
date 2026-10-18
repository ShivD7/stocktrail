import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readConfig } from './config.js';
import { readStoredToken } from './auth.js';
import { adminEvidenceReportSchema, type AdminEvidenceReport } from '../../shared/src/admin-evidence.js';
import type { ProductContent, ProposalArtifact, ProposalField, ProposalSnapshot } from '../../shared/src/proposals.js';
import {
  openCatalogRepository,
  type CatalogRepository,
  type StoredProposal,
} from '../../database/src/catalog-repository.js';
import {
  contentFingerprint,
  createImprovementProposal,
  createRevertProposal,
} from '../../proposals/src/index.js';
import {
  readProposalArtifact,
  removeProposalArtifacts,
  writeProposalArtifacts,
  writeProposalAttemptArtifact,
} from './proposal-storage.js';
import { ShopifyAdminClient } from '../../shopify/src/admin-client.js';
import { readAdminProductEvidence } from '../../shopify/src/admin-evidence.js';
import { requireProductWriteScope, verifyShopifyToken } from '../../shopify/src/admin.js';
import {
  ShopifyMutationOutcomeUnknownError,
  ShopifyProductMutationClient,
  type ProductUpdateResult,
} from '../../shopify/src/product-update.js';
import { scanEvidenceBundle, type CombinedScanResult } from './combined-scan.js';

export type ImproveResult = {
  proposal: ProposalArtifact | null;
  guidanceCodes: string[];
};

export type ApplyResult = {
  status: 'stale' | 'not_applied' | 'ambiguous' | 'applied';
  verification: 'not_started' | 'verified' | 'failed' | 'inconclusive' | 'drifted';
  diagnosticOutcome: 'pass' | 'fail' | 'inconclusive' | null;
  changedFields: ProposalField[];
};

export type ProposalServiceDependencies = {
  openRepository(directory: string): Promise<CatalogRepository>;
  readToken(shop: string): Promise<string>;
  readAdmin(shop: string, token: string, productId: string): Promise<AdminEvidenceReport>;
  verifyWriteScope(shop: string, token: string): Promise<void>;
  mutate(shop: string, token: string, productId: string, candidate: ProductContent, fields: ProposalField[]): Promise<ProductUpdateResult>;
  verify(directory: string, productId: string): Promise<CombinedScanResult>;
  now(): Date;
  uuid(): string;
};

const defaultDependencies: ProposalServiceDependencies = {
  openRepository: openCatalogRepository,
  readToken: readStoredToken,
  async readAdmin(shop, token, productId) { return readAdminProductEvidence(new ShopifyAdminClient(shop, token), productId); },
  async verifyWriteScope(shop, token) { requireProductWriteScope(await verifyShopifyToken(shop, token)); },
  async mutate(shop, token, productId, candidate, fields) {
    return new ShopifyProductMutationClient(shop, token).productUpdate(productId, candidate, fields);
  },
  async verify(directory, productId) {
    return scanEvidenceBundle(directory, productId, undefined, { browser: true, cartAdd: false });
  },
  now: () => new Date(),
  uuid: randomUUID,
};

function contentFromAdmin(admin: AdminEvidenceReport): ProductContent {
  if (admin.product.title === undefined || admin.product.descriptionHtml === undefined || admin.product.seo === undefined) {
    throw new Error('Fresh Admin evidence does not contain the complete product content required for a proposal.');
  }
  return {
    title: admin.product.title,
    descriptionHtml: admin.product.descriptionHtml,
    seo: { title: admin.product.seo.title, description: admin.product.seo.description },
  };
}

export function snapshotFromAdmin(admin: AdminEvidenceReport, evidenceRunId: string): ProposalSnapshot {
  const content = contentFromAdmin(admin);
  const latest = admin.product.variants.reduce<string | null>((value, variant) => {
    if (value === null || Date.parse(variant.inventoryItem.updatedAt) > Date.parse(value)) return variant.inventoryItem.updatedAt;
    return value;
  }, null);
  if (latest === null) throw new Error('Admin evidence has no inventory timestamp for proposal scoring.');
  return {
    productId: admin.product.id,
    productUpdatedAt: admin.product.updatedAt,
    latestInventoryUpdatedAt: latest,
    observedAt: admin.observationWindow.completedAt,
    evidenceRunId,
    content,
    fingerprint: contentFingerprint(admin.product.id, admin.product.updatedAt, content),
  };
}

async function readIndexedAdminArtifact(
  directory: string,
  evidenceRunId: string,
  expectedSha256: string,
): Promise<AdminEvidenceReport> {
  const path = join(directory, 'artifacts', 'scans', evidenceRunId, 'admin.json');
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error('Unsafe Admin evidence artifact.');
  const bytes = await readFile(path);
  if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) {
    throw new Error('Admin evidence artifact integrity check failed.');
  }
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Admin evidence artifact is malformed.'); }
  const parsed = adminEvidenceReportSchema.safeParse(value);
  if (!parsed.success) throw new Error('Admin evidence artifact is malformed.');
  return parsed.data;
}

async function configuredShop(directory: string): Promise<string> {
  const config = await readConfig(directory);
  if (!config.shop) throw new Error('No shop is configured. Run stocktrail init --shop your-store.myshopify.com first.');
  return config.shop;
}

export async function improveProduct(
  directory: string,
  productId: string,
  dependencies: ProposalServiceDependencies = defaultDependencies,
): Promise<ImproveResult> {
  const shop = await configuredShop(directory);
  const repository = await dependencies.openRepository(directory);
  let proposal: ProposalArtifact | null = null;
  try {
    repository.recoverInterruptedProposals(dependencies.now().toISOString());
    const evidence = repository.latestProposalEvidence(shop, productId);
    if (!evidence) throw new Error('No Phase 3 browser diagnostic is available. Run stocktrail scan --browser first.');
    const admin = await readIndexedAdminArtifact(directory, evidence.evidenceRunId, evidence.adminArtifactSha256);
    const result = createImprovementProposal({
      id: dependencies.uuid(),
      createdAt: dependencies.now().toISOString(),
      snapshot: snapshotFromAdmin(admin, evidence.evidenceRunId),
      currentReadiness: evidence.readiness,
    });
    proposal = result.proposal;
    if (!proposal) return result;
    const artifacts = await writeProposalArtifacts(directory, proposal);
    try { repository.recordProposal(shop, proposal, artifacts); }
    catch (error) { await removeProposalArtifacts(directory, proposal.id).catch(() => undefined); throw error; }
    return result;
  } finally { repository.close(); }
}

export async function listProposals(directory: string): Promise<StoredProposal[]> {
  const shop = await configuredShop(directory);
  const repository = await openCatalogRepository(directory);
  try {
    repository.recoverInterruptedProposals(new Date().toISOString());
    return repository.listProposals(shop);
  } finally { repository.close(); }
}

export async function proposalStatus(directory: string, proposalId: string): Promise<StoredProposal> {
  const repository = await openCatalogRepository(directory);
  try {
    repository.recoverInterruptedProposals(new Date().toISOString());
    return repository.getProposal(proposalId);
  } finally { repository.close(); }
}

export async function proposalDetails(directory: string, proposalId: string): Promise<{ stored: StoredProposal; proposal: ProposalArtifact }> {
  const repository = await openCatalogRepository(directory);
  try {
    repository.recoverInterruptedProposals(new Date().toISOString());
    const stored = repository.getProposal(proposalId);
    const proposal = await readProposalArtifact(directory, proposalId, stored.proposalArtifactSha256, stored.proposalArtifactBytes);
    return { stored, proposal };
  } finally { repository.close(); }
}

export async function rejectProposal(directory: string, proposalId: string): Promise<void> {
  const repository = await openCatalogRepository(directory);
  try { repository.rejectProposal(proposalId, new Date().toISOString()); }
  finally { repository.close(); }
}

export async function reconcileProposalStatus(
  directory: string,
  proposalId: string,
  dependencies: ProposalServiceDependencies = defaultDependencies,
): Promise<StoredProposal> {
  const shop = await configuredShop(directory);
  const repository = await dependencies.openRepository(directory);
  try {
    repository.recoverInterruptedProposals(dependencies.now().toISOString());
    let stored = repository.getProposal(proposalId);
    const proposal = await readProposalArtifact(directory, proposalId, stored.proposalArtifactSha256, stored.proposalArtifactBytes);
    if (stored.status === 'ambiguous') {
      const attempt = repository.proposalWriteAttempt(proposalId);
      if (!attempt) throw new Error('Ambiguous proposal has no write attempt to reconcile.');
      const token = await dependencies.readToken(shop);
      let outcome: 'candidate' | 'base' | 'ambiguous' | 'unreadable' = 'unreadable';
      try {
        const admin = await dependencies.readAdmin(shop, token, proposal.productId);
        outcome = classifyReconciliation(proposal, snapshotFromAdmin(admin, dependencies.uuid()));
      } catch { /* Read-only reconciliation remains unreadable. */ }
      repository.reconcileProposalWrite(proposalId, attempt.id, outcome, dependencies.now().toISOString(), ['manual_reconciliation']);
      stored = repository.getProposal(proposalId);
    }
    if (stored.status === 'applied' && stored.verificationStatus !== 'verified') {
      await verifyApplied(directory, proposal, repository, dependencies);
      stored = repository.getProposal(proposalId);
    }
    return stored;
  } finally { repository.close(); }
}

function changedFields(base: ProposalSnapshot, current: ProposalSnapshot): ProposalField[] {
  const changed: ProposalField[] = [];
  if (base.content.title !== current.content.title) changed.push('title');
  if (base.content.descriptionHtml !== current.content.descriptionHtml) changed.push('descriptionHtml');
  if (base.content.seo.title !== current.content.seo.title) changed.push('seo.title');
  if (base.content.seo.description !== current.content.seo.description) changed.push('seo.description');
  return changed;
}

function exactContent(left: ProductContent, right: ProductContent): boolean {
  return left.title === right.title && left.descriptionHtml === right.descriptionHtml &&
    left.seo.title === right.seo.title && left.seo.description === right.seo.description;
}

export function classifyReconciliation(
  proposal: ProposalArtifact,
  fresh: ProposalSnapshot,
): 'candidate' | 'base' | 'ambiguous' {
  if (exactContent(fresh.content, proposal.candidate)) return 'candidate';
  if (fresh.productUpdatedAt === proposal.base.productUpdatedAt && exactContent(fresh.content, proposal.base.content)) return 'base';
  return 'ambiguous';
}

async function verifyApplied(
  directory: string,
  proposal: ProposalArtifact,
  repository: CatalogRepository,
  dependencies: ProposalServiceDependencies,
): Promise<Pick<ApplyResult, 'verification' | 'diagnosticOutcome'>> {
  try {
    const result = await dependencies.verify(directory, proposal.productId);
    const verificationEvidence = repository.latestProposalEvidence(
      (await readConfig(directory)).shop ?? '', proposal.productId,
    );
    if (!verificationEvidence || verificationEvidence.evidenceRunId !== result.bundle.runId) {
      repository.setProposalVerification(proposal.id, 'failed', null, dependencies.now().toISOString());
      return { verification: 'failed', diagnosticOutcome: null };
    }
    const admin = await readIndexedAdminArtifact(directory, verificationEvidence.evidenceRunId, verificationEvidence.adminArtifactSha256);
    const snapshot = snapshotFromAdmin(admin, verificationEvidence.evidenceRunId);
    if (!exactContent(snapshot.content, proposal.candidate)) {
      repository.setProposalVerification(proposal.id, 'drifted', verificationEvidence.evidenceRunId, dependencies.now().toISOString());
      return { verification: 'drifted', diagnosticOutcome: null };
    }
    const diagnosticOutcome = result.evaluations?.some(value => value.result === 'fail') ? 'fail'
      : result.evaluations?.some(value => value.result === 'inconclusive') ? 'inconclusive' : 'pass';
    const verification = diagnosticOutcome === 'inconclusive' ? 'inconclusive' : 'verified';
    repository.setProposalVerification(proposal.id, verification, verificationEvidence.evidenceRunId, dependencies.now().toISOString());
    return { verification, diagnosticOutcome };
  } catch {
    repository.setProposalVerification(proposal.id, 'failed', null, dependencies.now().toISOString());
    return { verification: 'failed', diagnosticOutcome: null };
  }
}

export async function applyProposal(
  directory: string,
  proposalId: string,
  approval: string,
  acknowledgeRevertRisk: boolean,
  dependencies: ProposalServiceDependencies = defaultDependencies,
): Promise<ApplyResult> {
  const shop = await configuredShop(directory);
  const repository = await dependencies.openRepository(directory);
  try {
    repository.recoverInterruptedProposals(dependencies.now().toISOString());
    const stored = repository.getProposal(proposalId);
    if (stored.status !== 'ready') throw new Error('Proposal is not ready to apply.');
    const proposal = await readProposalArtifact(directory, proposalId, stored.proposalArtifactSha256, stored.proposalArtifactBytes);
    const expectedApproval = `${proposal.kind === 'revert' ? 'REVERT' : 'APPLY'} ${proposal.id}`;
    if (approval !== expectedApproval) throw new Error(`Approval must exactly match: ${expectedApproval}`);
    if (proposal.kind === 'revert' && proposal.validation.warningCodes.length > 0 && !acknowledgeRevertRisk) {
      throw new Error('This revert has safety warnings; --acknowledge-revert-risk is required.');
    }
    const token = await dependencies.readToken(shop);
    await dependencies.verifyWriteScope(shop, token);
    const freshAdmin = await dependencies.readAdmin(shop, token, proposal.productId);
    const fresh = snapshotFromAdmin(freshAdmin, dependencies.uuid());
    const staleFields = changedFields(proposal.base, fresh);
    if (fresh.productUpdatedAt !== proposal.base.productUpdatedAt || staleFields.length > 0) {
      repository.markProposalStale(
        proposal.id, dependencies.now().toISOString(), staleFields,
        fresh.productUpdatedAt !== proposal.base.productUpdatedAt,
      );
      return { status: 'stale', verification: 'not_started', diagnosticOutcome: null, changedFields: staleFields };
    }
    repository.approveProposal(proposal.id, dependencies.now().toISOString());
    const attemptId = dependencies.uuid();
    repository.beginProposalWrite(proposal.id, attemptId, dependencies.now().toISOString());
    let mutationCodes: string[] = [];
    let mutationSummary: unknown = { outcome: 'response_not_confirmed', errorCodes: [] };
    try {
      const response = await dependencies.mutate(shop, token, proposal.productId, proposal.candidate, proposal.changes.map(change => change.field));
      mutationSummary = {
        outcome: 'response_received',
        productIdMatched: response.productId === proposal.productId,
        updatedAtPresent: response.updatedAt.length > 0,
        errorCodes: response.errorCodes,
      };
      mutationCodes = response.errorCodes;
    } catch (error) {
      mutationCodes = error instanceof ShopifyMutationOutcomeUnknownError ? error.safeCodes : ['mutation_failure'];
      mutationSummary = { outcome: 'response_not_confirmed', errorCodes: mutationCodes };
    }
    const mutationArtifact = await writeProposalAttemptArtifact(directory, proposal.id, attemptId, 'mutation_response', mutationSummary);
    repository.addProposalArtifacts(proposal.id, [mutationArtifact]);
    let reconciled: ProposalSnapshot | null = null;
    try {
      const afterAdmin = await dependencies.readAdmin(shop, token, proposal.productId);
      reconciled = snapshotFromAdmin(afterAdmin, dependencies.uuid());
      const artifact = await writeProposalAttemptArtifact(directory, proposal.id, attemptId, 'reconciled_admin', reconciled);
      repository.addProposalArtifacts(proposal.id, [artifact]);
    } catch { mutationCodes.push('reconciliation_read_failed'); }
    const outcome = reconciled === null ? 'unreadable' : classifyReconciliation(proposal, reconciled);
    repository.reconcileProposalWrite(proposal.id, attemptId, outcome, dependencies.now().toISOString(), [...new Set(mutationCodes)]);
    if (outcome !== 'candidate') {
      return { status: outcome === 'base' ? 'not_applied' : 'ambiguous', verification: 'not_started', diagnosticOutcome: null, changedFields: proposal.changes.map(change => change.field) };
    }
    const verified = await verifyApplied(directory, proposal, repository, dependencies);
    return { status: 'applied', ...verified, changedFields: proposal.changes.map(change => change.field) };
  } finally { repository.close(); }
}

export async function createRevert(
  directory: string,
  parentProposalId: string,
  dependencies: ProposalServiceDependencies = defaultDependencies,
): Promise<ProposalArtifact> {
  const shop = await configuredShop(directory);
  const repository = await dependencies.openRepository(directory);
  let proposal: ProposalArtifact | null = null;
  try {
    repository.recoverInterruptedProposals(dependencies.now().toISOString());
    const parentStored = repository.getProposal(parentProposalId);
    if (parentStored.status !== 'applied' || parentStored.verificationStatus !== 'verified' || !parentStored.verificationEvidenceRunId) {
      throw new Error('Only a verified applied proposal can produce a revert proposal.');
    }
    const parent = await readProposalArtifact(
      directory,
      parentProposalId,
      parentStored.proposalArtifactSha256,
      parentStored.proposalArtifactBytes,
    );
    const evidence = repository.latestProposalEvidence(shop, parent.productId);
    if (!evidence || evidence.evidenceRunId !== parentStored.verificationEvidenceRunId) {
      throw new Error('The verified after evidence is no longer the latest product diagnostic. Create a new improvement proposal instead.');
    }
    const admin = await readIndexedAdminArtifact(directory, evidence.evidenceRunId, evidence.adminArtifactSha256);
    proposal = createRevertProposal({
      id: dependencies.uuid(), createdAt: dependencies.now().toISOString(), parent,
      base: snapshotFromAdmin(admin, evidence.evidenceRunId), currentReadiness: evidence.readiness,
    });
    if (!proposal.validation.valid) throw new Error(`A safe revert proposal could not be created: ${proposal.validation.reasonCodes.join(', ')}.`);
    const artifacts = await writeProposalArtifacts(directory, proposal);
    try { repository.recordProposal(shop, proposal, artifacts); }
    catch (error) { await removeProposalArtifacts(directory, proposal.id).catch(() => undefined); throw error; }
    return proposal;
  } finally { repository.close(); }
}
