import type { ProposalArtifact } from '../../../packages/shared/src/proposals.js';
import type { StoredProposal } from '../../../packages/database/src/catalog-repository.js';
import { createFieldDiffs } from '../../../packages/proposals/src/index.js';

function safe(value: string, maximum = 4_000): string {
  const escaped = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u009b]/gu, character =>
    `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`)
    .replace(/\u001b/gu, '\\u001b');
  return escaped.length <= maximum ? escaped : `${escaped.slice(0, maximum)}\n… diff output truncated …`;
}

function score(value: number | null): string { return value === null ? 'inconclusive' : `${value}/100`; }

export function formatProposalPreview(proposal: ProposalArtifact): string[] {
  const lines = [
    `Proposal: ${proposal.id}`,
    `Kind: ${proposal.kind}`,
    `Product: ${proposal.productId}`,
    `Source evidence: ${proposal.sourceEvidenceRunId}`,
    `Inventory Search Readiness: ${score(proposal.currentReadiness.total)} -> ${score(proposal.predictedReadiness.total)} predicted.`,
    'Predicted readiness is a simulation; no Shopify or storefront change has been observed.',
    `Changed fields: ${proposal.changes.map(change => change.field).join(', ')}.`,
  ];
  if (proposal.validation.warningCodes.length) lines.push(`Warnings: ${proposal.validation.warningCodes.join(', ')}.`);
  for (const diff of createFieldDiffs(proposal.changes)) {
    lines.push('', `--- ${diff.field} (${diff.mode} diff) ---`);
    if (diff.truncated) lines.push('INFO Diff complexity limit reached; showing bounded replacement blocks.');
    for (const part of diff.parts) {
      const prefix = part.kind === 'add' ? '+' : part.kind === 'remove' ? '-' : ' ';
      lines.push(`${prefix} ${safe(part.value)}`);
    }
  }
  return lines;
}

export function formatProposalStatus(value: StoredProposal): string[] {
  return [
    `Proposal: ${value.id}`,
    `Product: ${value.productGid}`,
    `Kind: ${value.kind}`,
    `Status: ${value.status}`,
    `Verification: ${value.verificationStatus}`,
    `Readiness: ${score(value.currentScore)} -> ${score(value.predictedScore)} predicted -> ${score(value.verifiedScore)} verified.`,
    `Changed fields: ${value.changedFields.join(', ')}.`,
    ...(value.warningCodes.length ? [`Warnings: ${value.warningCodes.join(', ')}.`] : []),
  ];
}

export function formatProposalList(values: StoredProposal[]): string[] {
  if (values.length === 0) return ['No proposals.'];
  return values.map(value => `${value.id}  ${value.kind}  ${value.status}/${value.verificationStatus}  ${value.changedFields.join(',')}`);
}
