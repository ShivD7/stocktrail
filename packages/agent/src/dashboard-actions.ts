import type { CatalogRepository, StoredProposal } from '../../database/src/catalog-repository.js';
import { openCatalogRepository } from '../../database/src/catalog-repository.js';
import {
  dashboardApplyResultSchema,
  dashboardImproveResultSchema,
  dashboardImportResultSchema,
  dashboardMonitoringResultSchema,
  dashboardProposalActionResultSchema,
  dashboardProposalDetailSchema,
  dashboardRevertResultSchema,
  dashboardRerunResultSchema,
  dashboardScanResultSchema,
  type DashboardApplyRequest,
  type DashboardApplyResult,
  type DashboardErrorCode,
  type DashboardImproveResult,
  type DashboardImportResult,
  type DashboardMonitoringRequest,
  type DashboardMonitoringResult,
  type DashboardProposalActionResult,
  type DashboardProposalDetail,
  type DashboardRevertResult,
  type DashboardRerunResult,
  type DashboardScanResult,
} from '../../shared/src/dashboard.js';
import type { ProposalArtifact } from '../../shared/src/proposals.js';
import { createFieldDiffs } from '../../proposals/src/index.js';
import { persistCatalogImport } from './import.js';
import { updateMonitoringSelection } from './monitoring.js';
import { scanEvidenceBundle, type CombinedScanResult } from './combined-scan.js';
import {
  applyProposal,
  createRevert,
  improveProduct,
  listProposals,
  proposalDetails,
  proposalStatus,
  reconcileProposalStatus,
  rejectProposal,
  type ApplyResult,
  type ImproveResult,
} from './proposals.js';
import {
  runBrowserRegressionTestForIncident,
  type StoredTestRunResult,
} from '../../test-runner/src/index.js';

export class DashboardActionError extends Error {
  constructor(
    readonly code: DashboardErrorCode,
    readonly status: 400 | 403 | 404 | 409 | 422 | 500,
  ) {
    super(code);
  }
}

export type DashboardActionDependencies = {
  openRepository(directory: string): Promise<CatalogRepository>;
  importCatalog(directory: string, limit: number): Promise<DashboardImportResult>;
  monitor(directory: string, action: 'add' | 'remove', productId: string): Promise<{
    monitoredProductCount: number; activeMonitoredProductCount: number; limit: number;
  }>;
  scan(directory: string, productId: string): Promise<CombinedScanResult>;
  improve(directory: string, productId: string): Promise<ImproveResult>;
  list(directory: string): Promise<StoredProposal[]>;
  status(directory: string, proposalId: string): Promise<StoredProposal>;
  details(directory: string, proposalId: string): Promise<{ stored: StoredProposal; proposal: ProposalArtifact }>;
  reject(directory: string, proposalId: string): Promise<void>;
  apply(directory: string, proposalId: string, confirmation: string, acknowledge: boolean): Promise<ApplyResult>;
  reconcile(directory: string, proposalId: string): Promise<StoredProposal>;
  revert(directory: string, proposalId: string): Promise<ProposalArtifact>;
  rerun(directory: string, shop: string, incidentId: string): Promise<StoredTestRunResult>;
};

const defaultDependencies: DashboardActionDependencies = {
  openRepository: openCatalogRepository,
  importCatalog: persistCatalogImport,
  monitor: updateMonitoringSelection,
  scan: (directory, productId) => scanEvidenceBundle(directory, productId, undefined, { browser: true, cartAdd: false }),
  improve: improveProduct,
  list: listProposals,
  status: proposalStatus,
  details: proposalDetails,
  reject: rejectProposal,
  apply: applyProposal,
  reconcile: reconcileProposalStatus,
  revert: createRevert,
  rerun: runBrowserRegressionTestForIncident,
};

function proposalAllowedActions(stored: StoredProposal): DashboardProposalDetail['allowedActions'] {
  if (stored.status === 'ready') return ['reject', 'apply'];
  if (stored.status === 'ambiguous' || (stored.status === 'applied' && stored.verificationStatus !== 'verified')) {
    return ['reconcile'];
  }
  if (stored.status === 'applied' && stored.verificationStatus === 'verified') return ['create_revert'];
  return [];
}

function mapActionError(error: unknown): never {
  if (error instanceof DashboardActionError) throw error;
  const message = error instanceof Error ? error.message : '';
  if (/does not exist|unknown product|not available|no Phase 3/i.test(message)) {
    throw new DashboardActionError('not_found', 404);
  }
  if (/Approval must exactly match/i.test(message)) throw new DashboardActionError('confirmation_mismatch', 422);
  if (/acknowledge-revert-risk|safety warnings/i.test(message)) {
    throw new DashboardActionError('warning_acknowledgement_required', 422);
  }
  if (/write_products|write scope/i.test(message)) throw new DashboardActionError('write_scope_required', 403);
  if (/not ready|valid state|approved|already|latest product diagnostic/i.test(message)) {
    throw new DashboardActionError('conflict', 409);
  }
  if (/safe revert|complete product content|inventory timestamp|guidance/i.test(message)) {
    throw new DashboardActionError('unprocessable', 422);
  }
  if (/artifact|Unsafe/i.test(message)) throw new DashboardActionError('artifact_integrity_failed', 500);
  throw error;
}

export type DashboardActions = ReturnType<typeof createDashboardActions>;

export function createDashboardActions(
  directory: string,
  shop: string,
  dependencies: DashboardActionDependencies = defaultDependencies,
) {
  async function scopedProduct(productId: string): Promise<void> {
    const repository = await dependencies.openRepository(directory);
    try {
      if (!repository.dashboardProduct(shop, productId)) throw new DashboardActionError('not_found', 404);
    } finally { repository.close(); }
  }

  async function scopedProposal(proposalId: string): Promise<StoredProposal> {
    const repository = await dependencies.openRepository(directory);
    try {
      const proposal = repository.getProposalForShop(shop, proposalId);
      if (!proposal) throw new DashboardActionError('not_found', 404);
      return proposal;
    } finally { repository.close(); }
  }

  async function scopedIncident(incidentId: string): Promise<void> {
    const repository = await dependencies.openRepository(directory);
    try {
      if (!repository.dashboardIncident(shop, incidentId)) throw new DashboardActionError('not_found', 404);
    } finally { repository.close(); }
  }

  return {
    async importCatalog(limit: number): Promise<DashboardImportResult> {
      try { return dashboardImportResultSchema.parse(await dependencies.importCatalog(directory, limit)); }
      catch (error) { return mapActionError(error); }
    },
    async monitoring(input: DashboardMonitoringRequest): Promise<DashboardMonitoringResult> {
      await scopedProduct(input.productId);
      try {
        const result = await dependencies.monitor(directory, input.action, input.productId);
        return dashboardMonitoringResultSchema.parse({
          selected: result.monitoredProductCount,
          active: result.activeMonitoredProductCount,
          limit: result.limit,
        });
      } catch (error) { return mapActionError(error); }
    },
    async scan(productId: string): Promise<DashboardScanResult> {
      await scopedProduct(productId);
      try {
        const result = await dependencies.scan(directory, productId);
        return dashboardScanResultSchema.parse({
          evidenceRunId: result.bundle.runId,
          collectionStatus: result.bundle.collectionStatus,
          readinessScore: result.readinessTotal ?? null,
        });
      } catch (error) { return mapActionError(error); }
    },
    async improve(productId: string): Promise<DashboardImproveResult> {
      await scopedProduct(productId);
      try {
        const result = await dependencies.improve(directory, productId);
        return dashboardImproveResultSchema.parse({
          proposalId: result.proposal?.id ?? null,
          guidanceCodes: result.guidanceCodes,
        });
      } catch (error) { return mapActionError(error); }
    },
    async proposals(): Promise<StoredProposal[]> {
      return dependencies.list(directory);
    },
    async proposalStatus(proposalId: string): Promise<StoredProposal> {
      await scopedProposal(proposalId);
      return dependencies.status(directory, proposalId);
    },
    async proposal(proposalId: string): Promise<DashboardProposalDetail> {
      await scopedProposal(proposalId);
      try {
        const { stored, proposal } = await dependencies.details(directory, proposalId);
        return dashboardProposalDetailSchema.parse({
          id: stored.id,
          productGid: stored.productGid,
          kind: stored.kind,
          parentProposalId: stored.parentProposalId,
          status: stored.status,
          verificationStatus: stored.verificationStatus,
          sourceEvidenceRunId: stored.sourceEvidenceRunId,
          verificationEvidenceRunId: stored.verificationEvidenceRunId,
          changes: proposal.changes.map(change => ({
            field: change.field,
            before: change.before,
            after: change.after,
            beforeHash: change.beforeHash,
            afterHash: change.afterHash,
            displayMode: 'text',
          })),
          diffs: createFieldDiffs(proposal.changes),
          validation: proposal.validation,
          scores: { current: stored.currentScore, predicted: stored.predictedScore, verified: stored.verifiedScore },
          createdAt: stored.createdAt,
          completedAt: stored.completedAt,
          allowedActions: proposalAllowedActions(stored),
        });
      } catch (error) { return mapActionError(error); }
    },
    async rerun(incidentId: string): Promise<DashboardRerunResult> {
      await scopedIncident(incidentId);
      try {
        const result = await dependencies.rerun(directory, shop, incidentId);
        return dashboardRerunResultSchema.parse(result.summary ? {
          status: result.summary.status,
          passed: result.summary.passed,
          failed: result.summary.failed,
          inconclusive: result.summary.inconclusive,
        } : { status: 'no_tests', passed: 0, failed: 0, inconclusive: 0 });
      } catch (error) { return mapActionError(error); }
    },
    async reject(proposalId: string): Promise<DashboardProposalActionResult> {
      await scopedProposal(proposalId);
      try {
        await dependencies.reject(directory, proposalId);
        const stored = await scopedProposal(proposalId);
        return dashboardProposalActionResultSchema.parse({ proposalId, status: stored.status, verificationStatus: stored.verificationStatus });
      } catch (error) { return mapActionError(error); }
    },
    async apply(proposalId: string, input: DashboardApplyRequest): Promise<DashboardApplyResult> {
      await scopedProposal(proposalId);
      try {
        const result = await dependencies.apply(directory, proposalId, input.confirmation, input.acknowledgeWarnings);
        return dashboardApplyResultSchema.parse({ proposalId, ...result });
      } catch (error) { return mapActionError(error); }
    },
    async reconcile(proposalId: string): Promise<DashboardProposalActionResult> {
      await scopedProposal(proposalId);
      try {
        const stored = await dependencies.reconcile(directory, proposalId);
        return dashboardProposalActionResultSchema.parse({ proposalId, status: stored.status, verificationStatus: stored.verificationStatus });
      } catch (error) { return mapActionError(error); }
    },
    async revert(proposalId: string): Promise<DashboardRevertResult> {
      await scopedProposal(proposalId);
      try {
        const proposal = await dependencies.revert(directory, proposalId);
        return dashboardRevertResultSchema.parse({
          proposalId: proposal.id,
          parentProposalId: proposalId,
          status: 'ready',
          warningCodes: proposal.validation.warningCodes,
        });
      } catch (error) { return mapActionError(error); }
    },
  };
}
