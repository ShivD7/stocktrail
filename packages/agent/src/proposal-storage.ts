import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { proposalArtifactSchema, type ProposalArtifact } from '../../shared/src/proposals.js';
import { hardenWindowsAcl } from './admin-scan.js';
import { createFieldDiffs } from '../../proposals/src/index.js';

export type ProposalStoredArtifact = {
  role: 'proposal' | 'before' | 'candidate' | 'diff' | 'mutation_response' | 'reconciled_admin';
  relativePath: string;
  mediaType: 'application/json';
  sha256: string;
  bytes: number;
};

function describe(role: ProposalStoredArtifact['role'], relativePath: string, contents: string): ProposalStoredArtifact {
  const bytes = Buffer.from(contents, 'utf8');
  return { role, relativePath, mediaType: 'application/json', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

async function secureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('Unsafe proposal artifact directory.');
  if (process.platform === 'win32') await hardenWindowsAcl(path, 'directory');
  else await chmod(path, 0o700);
}

async function privateWrite(path: string, contents: string): Promise<void> {
  await secureDirectory(dirname(path));
  const file = await open(path, 'wx', 0o600);
  try {
    if (process.platform === 'win32') await hardenWindowsAcl(path, 'file');
    await file.writeFile(contents, 'utf8');
    await file.sync();
  } finally { await file.close(); }
}

function assertUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error('Invalid proposal identifier.');
  }
}

export async function writeProposalArtifacts(directory: string, proposal: ProposalArtifact): Promise<ProposalStoredArtifact[]> {
  assertUuid(proposal.id);
  const root = join(directory, 'artifacts', 'proposals');
  const stagingRoot = join(root, '.staging');
  const staging = join(stagingRoot, proposal.id);
  const final = join(root, proposal.id);
  const values: Array<[ProposalStoredArtifact['role'], string, string]> = [
    ['proposal', 'proposal.json', JSON.stringify(proposal, null, 2) + '\n'],
    ['before', 'before.json', JSON.stringify(proposal.base, null, 2) + '\n'],
    ['candidate', 'candidate.json', JSON.stringify(proposal.candidate, null, 2) + '\n'],
    ['diff', 'diff.json', JSON.stringify(createFieldDiffs(proposal.changes), null, 2) + '\n'],
  ];
  let moved = false;
  try {
    await secureDirectory(root);
    await secureDirectory(stagingRoot);
    await mkdir(staging, { recursive: false, mode: 0o700 });
    if (process.platform === 'win32') await hardenWindowsAcl(staging, 'directory');
    for (const [, name, contents] of values) await privateWrite(join(staging, name), contents);
    await rename(staging, final);
    moved = true;
    return values.map(([role, name, contents]) => describe(role, name, contents));
  } catch {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (moved) await rm(final, { recursive: true, force: true }).catch(() => undefined);
    throw new Error('Could not save proposal artifacts securely. No proposal was saved.');
  }
}

export async function readProposalArtifact(directory: string, proposalId: string, expectedSha256?: string): Promise<ProposalArtifact> {
  assertUuid(proposalId);
  const path = join(directory, 'artifacts', 'proposals', proposalId, 'proposal.json');
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error('Unsafe proposal artifact.');
  const contents = await readFile(path, 'utf8');
  const actual = createHash('sha256').update(Buffer.from(contents, 'utf8')).digest('hex');
  if (expectedSha256 !== undefined && actual !== expectedSha256) throw new Error('Proposal artifact integrity check failed.');
  let value: unknown;
  try { value = JSON.parse(contents); } catch { throw new Error('Proposal artifact is malformed.'); }
  const parsed = proposalArtifactSchema.safeParse(value);
  if (!parsed.success || parsed.data.id !== proposalId) throw new Error('Proposal artifact is malformed.');
  return parsed.data;
}

export async function writeProposalAttemptArtifact(
  directory: string,
  proposalId: string,
  attemptId: string,
  role: 'mutation_response' | 'reconciled_admin',
  value: unknown,
): Promise<ProposalStoredArtifact> {
  assertUuid(proposalId); assertUuid(attemptId);
  const name = role === 'mutation_response' ? 'mutation-response.json' : 'reconciled-admin.json';
  const relativePath = `attempts/${attemptId}/${name}`;
  const contents = JSON.stringify(value, null, 2) + '\n';
  const finalPath = join(directory, 'artifacts', 'proposals', proposalId, relativePath);
  const temporaryPath = `${finalPath}.${randomUUID()}.tmp`;
  try {
    await privateWrite(temporaryPath, contents);
    await rename(temporaryPath, finalPath);
  } catch {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new Error('Could not save the proposal attempt artifact securely.');
  }
  return describe(role, relativePath, contents);
}

export async function removeProposalArtifacts(directory: string, proposalId: string): Promise<void> {
  assertUuid(proposalId);
  await rm(join(directory, 'artifacts', 'proposals', proposalId), { recursive: true, force: true });
}
