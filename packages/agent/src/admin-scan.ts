import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readConfig, type Config } from './config.js';
import { readStoredToken } from './auth.js';
import {
  adminEvidenceReportSchema,
  assertShopifyProductGid,
  type AdminEvidenceReport,
} from '../../shared/src/admin-evidence.js';
import { ShopifyAdminClient } from '../../shopify/src/admin-client.js';
import { readAdminProductEvidence } from '../../shopify/src/admin-evidence.js';
import { openCatalogRepository } from '../../database/src/catalog-repository.js';

export type AdminScanResult = { report: AdminEvidenceReport; path: string };

export type EvidenceStorageDependencies = {
  platform: NodeJS.Platform;
  makeDirectory(path: string): Promise<void>;
  openTemporary(path: string): Promise<{
    write(contents: string): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }>;
  hardenWindowsAcl(path: string, target: 'directory' | 'file'): Promise<void>;
  moveFile(from: string, to: string): Promise<void>;
  removeFile(path: string): Promise<void>;
};

export type AdminScanDependencies = {
  readConfig(directory: string): Promise<Config>;
  validateTarget(directory: string, shop: string, productId: string): Promise<void>;
  readToken(shop: string): Promise<string>;
  readEvidence(shop: string, token: string, productId: string): Promise<AdminEvidenceReport>;
  writeEvidence(directory: string, report: AdminEvidenceReport): Promise<string>;
};

export async function validateAdminScanTarget(
  directory: string,
  shop: string,
  productId: string,
): Promise<void> {
  const repository = await openCatalogRepository(directory);
  try {
    repository.validateAdminEvidenceTarget(shop, productId);
  } finally {
    repository.close();
  }
}

const execFileAsync = promisify(execFile);
const windowsAclScript = `
$ErrorActionPreference = 'Stop'
$target = $env:STOCKTRAIL_ACL_TARGET
if ([string]::IsNullOrWhiteSpace($target)) { throw 'Missing target.' }
$targetKind = $env:STOCKTRAIL_ACL_KIND
if ($targetKind -ne 'directory' -and $targetKind -ne 'file') { throw 'Invalid target kind.' }
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$isDirectory = $targetKind -eq 'directory'
if ($isDirectory) {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
} else {
  $acl = New-Object System.Security.AccessControl.FileSecurity
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
}
$acl.SetOwner($current.User)
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
  $current.User,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  $inheritance,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow
)
$acl.SetAccessRule($rule)
if ($isDirectory) {
  [System.IO.Directory]::SetAccessControl($target, $acl)
  $verified = [System.IO.Directory]::GetAccessControl(
    $target,
    [System.Security.AccessControl.AccessControlSections]::Access
  )
} else {
  [System.IO.File]::SetAccessControl($target, $acl)
  $verified = [System.IO.File]::GetAccessControl(
    $target,
    [System.Security.AccessControl.AccessControlSections]::Access
  )
}
$rules = @($verified.GetAccessRules(
  $true,
  $true,
  [System.Security.Principal.SecurityIdentifier]
))
if ($rules.Count -ne 1) { throw 'ACL verification failed.' }
$verifiedRule = $rules[0]
if ($verifiedRule.IsInherited) { throw 'ACL verification failed.' }
if ($verifiedRule.IdentityReference.Value -ne $current.User.Value) { throw 'ACL verification failed.' }
if ($verifiedRule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
  throw 'ACL verification failed.'
}
$required = [System.Security.AccessControl.FileSystemRights]::FullControl
if (($verifiedRule.FileSystemRights -band $required) -ne $required) { throw 'ACL verification failed.' }
if ($isDirectory) {
  $requiredInheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  if (($verifiedRule.InheritanceFlags -band $requiredInheritance) -ne $requiredInheritance) {
    throw 'ACL verification failed.'
  }
} elseif ($verifiedRule.InheritanceFlags -ne [System.Security.AccessControl.InheritanceFlags]::None) {
  throw 'ACL verification failed.'
}
`;

export async function hardenWindowsAcl(path: string, target: 'directory' | 'file'): Promise<void> {
  await execFileAsync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', windowsAclScript],
    {
      env: {
        ...process.env,
        STOCKTRAIL_ACL_TARGET: path,
        STOCKTRAIL_ACL_KIND: target,
      },
      timeout: 15_000,
      windowsHide: true,
    },
  );
}

const defaultStorageDependencies: EvidenceStorageDependencies = {
  platform: process.platform,
  async makeDirectory(path) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(path, 0o700);
  },
  async openTemporary(path) {
    const file = await open(path, 'wx', 0o600);
    return {
      async write(contents) { await file.writeFile(contents, { encoding: 'utf8' }); },
      async sync() { await file.sync(); },
      async close() { await file.close(); },
    };
  },
  hardenWindowsAcl,
  async moveFile(from, to) { await rename(from, to); },
  async removeFile(path) { await rm(path, { force: true }); },
};

export async function writeAdminEvidence(
  directory: string,
  reportInput: AdminEvidenceReport,
  storage: EvidenceStorageDependencies = defaultStorageDependencies,
): Promise<string> {
  const parsed = adminEvidenceReportSchema.safeParse(reportInput);
  if (!parsed.success) throw new Error('Cannot save an invalid Admin evidence report.');
  return writePrivateJsonReport(
    directory,
    'admin',
    JSON.stringify(parsed.data, null, 2) + '\n',
    storage,
  );
}

export async function writePrivateJsonReport(
  directory: string,
  prefix: 'admin' | 'ajax',
  contents: string,
  storage: EvidenceStorageDependencies = defaultStorageDependencies,
): Promise<string> {
  const reports = join(directory, 'reports');
  const id = randomUUID();
  const temporaryPath = join(reports, `.${prefix}-${id}.tmp`);
  const finalPath = join(reports, `${prefix}-${id}.json`);
  let file: Awaited<ReturnType<EvidenceStorageDependencies['openTemporary']>> | undefined;
  try {
    await storage.makeDirectory(reports);
    if (storage.platform === 'win32') await storage.hardenWindowsAcl(reports, 'directory');
    file = await storage.openTemporary(temporaryPath);
    if (storage.platform === 'win32') await storage.hardenWindowsAcl(temporaryPath, 'file');
    await file.write(contents);
    await file.sync();
    await file.close();
    file = undefined;
    await storage.moveFile(temporaryPath, finalPath);
    return finalPath;
  } catch {
    if (file !== undefined) await file.close().catch(() => undefined);
    await storage.removeFile(temporaryPath).catch(() => undefined);
    await storage.removeFile(finalPath).catch(() => undefined);
    throw new Error('Could not save the evidence report securely. No evidence was saved.');
  }
}

const defaultDependencies: AdminScanDependencies = {
  readConfig,
  validateTarget: validateAdminScanTarget,
  readToken: readStoredToken,
  async readEvidence(shop, token, productId) {
    return readAdminProductEvidence(new ShopifyAdminClient(shop, token), productId);
  },
  writeEvidence: writeAdminEvidence,
};

export async function scanAdminEvidence(
  directory: string,
  productId: string,
  dependencies: AdminScanDependencies = defaultDependencies,
): Promise<AdminScanResult> {
  assertShopifyProductGid(productId);
  const config = await dependencies.readConfig(directory);
  if (!config.shop) throw new Error('No shop is configured. Run stocktrail init --shop your-store.myshopify.com first.');
  await dependencies.validateTarget(directory, config.shop, productId);
  const token = await dependencies.readToken(config.shop);
  const report = await dependencies.readEvidence(config.shop, token, productId);
  const path = await dependencies.writeEvidence(directory, report);
  return { report, path };
}
