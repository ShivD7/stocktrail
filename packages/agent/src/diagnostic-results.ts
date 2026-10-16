import {
  openCatalogRepository,
  type CatalogRepository,
  type DiagnosticRecordInput,
} from '../../database/src/catalog-repository.js';

export type DiagnosticPersistenceDependencies = {
  openRepository(directory: string): Promise<CatalogRepository>;
};

const defaultDependencies: DiagnosticPersistenceDependencies = {
  openRepository: openCatalogRepository,
};

export async function persistDiagnosticResults(
  directory: string,
  shop: string,
  productId: string,
  input: DiagnosticRecordInput,
  dependencies: DiagnosticPersistenceDependencies = defaultDependencies,
): Promise<{ incidentCount: number; regressionTestCount: number }> {
  const repository = await dependencies.openRepository(directory);
  try {
    return repository.recordDiagnosticResults(shop, productId, input);
  } finally {
    repository.close();
  }
}
