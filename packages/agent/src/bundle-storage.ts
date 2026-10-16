import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { hardenWindowsAcl } from './admin-scan.js';
import {
  bundleArtifactSchema,
  productEvidenceBundleSchema,
  type BundleArtifact,
  type BundleArtifactSource,
  type ProductEvidenceBundle,
} from '../../shared/src/evidence-bundle.js';

export type BundleArtifactInput = {
  source: BundleArtifactSource;
  relativePath: BundleArtifact['relativePath'];
  mediaType: BundleArtifact['mediaType'];
  contents: string | Uint8Array;
};

function bytesOf(contents: string | Uint8Array): Uint8Array {
  return typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents;
}

export function describeBundleArtifact(input: BundleArtifactInput): BundleArtifact {
  const bytes = bytesOf(input.contents);
  return bundleArtifactSchema.parse({
    source: input.source,
    relativePath: input.relativePath,
    mediaType: input.mediaType,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  });
}

async function secureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('Unsafe evidence directory.');
  if (process.platform === 'win32') await hardenWindowsAcl(path, 'directory');
  else await chmod(path, 0o700);
}

async function writePrivateFile(path: string, contents: string | Uint8Array): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try {
    if (process.platform === 'win32') await hardenWindowsAcl(path, 'file');
    await file.writeFile(contents);
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function writeBundleRun(
  directory: string,
  runId: string,
  inputs: BundleArtifactInput[],
  bundleInput: ProductEvidenceBundle,
): Promise<{ bundle: ProductEvidenceBundle; finalDirectory: string; indexedArtifacts: BundleArtifact[] }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
    throw new Error('Invalid evidence run identifier.');
  }
  const allowed = new Set(['admin.json', 'ajax.json', 'html.html', 'jsonld.json', 'browser.json']);
  if (inputs.some(input => !allowed.has(input.relativePath) || input.relativePath.includes('..') ||
      input.relativePath.includes('/') || input.relativePath.includes('\\'))) {
    throw new Error('Invalid evidence artifact path.');
  }
  const artifactsRoot = join(directory, 'artifacts');
  const stagingRoot = join(artifactsRoot, '.staging');
  const scansRoot = join(artifactsRoot, 'scans');
  const stagingDirectory = join(stagingRoot, runId);
  const finalDirectory = join(scansRoot, runId);
  let moved = false;
  try {
    await secureDirectory(artifactsRoot);
    await secureDirectory(stagingRoot);
    await secureDirectory(scansRoot);
    await mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
    if (process.platform === 'win32') await hardenWindowsAcl(stagingDirectory, 'directory');
    const details = await lstat(stagingDirectory);
    if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('Unsafe evidence staging directory.');
    for (const input of inputs) await writePrivateFile(join(stagingDirectory, input.relativePath), input.contents);
    const bundle = productEvidenceBundleSchema.parse(bundleInput);
    const bundleText = JSON.stringify(bundle, null, 2) + '\n';
    await writePrivateFile(join(stagingDirectory, 'bundle.json'), bundleText);
    await rename(stagingDirectory, finalDirectory);
    moved = true;
    const indexedArtifacts = [
      ...inputs.map(describeBundleArtifact),
      describeBundleArtifact({ source: 'bundle', relativePath: 'bundle.json', mediaType: 'application/json', contents: bundleText }),
    ];
    return { bundle, finalDirectory, indexedArtifacts };
  } catch {
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    if (moved) await rm(finalDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw new Error('Could not save the evidence bundle securely. No evidence bundle was saved.');
  }
}

export async function removeBundleRun(finalDirectory: string): Promise<void> {
  await rm(finalDirectory, { recursive: true, force: true });
}
