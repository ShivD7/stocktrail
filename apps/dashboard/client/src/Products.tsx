import { useEffect, useMemo, useState } from 'react';
import type { DashboardImportResult, DashboardMonitoringResult, DashboardProductSummary } from '../../../../packages/shared/src/dashboard.js';
import { ActionButton, ErrorState, LoadingState } from './ActionButton.js';
import { apiGet, apiPost } from './api.js';

function scoreLabel(score: number | null): string {
  return score === null ? 'Inconclusive' : `${score}/100`;
}

function weakestLabel(product: DashboardProductSummary): string {
  return product.weakestComponent?.id.replaceAll('_', ' ') ?? 'No scored components';
}

export function Products({ onChanged }: { onChanged?: () => void }) {
  const [products, setProducts] = useState<DashboardProductSummary[] | null>(null);
  const [query, setQuery] = useState('');
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    void apiGet<DashboardProductSummary[]>('/api/products', controller.signal)
      .then(setProducts)
      .catch(value => { if (value?.name !== 'AbortError') setError(true); });
    return () => controller.abort();
  }, [revision]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!products || !needle) return products ?? [];
    return products.filter(product => product.title.toLocaleLowerCase().includes(needle) || product.productGid.includes(needle));
  }, [products, query]);

  function refresh() {
    setRevision(value => value + 1);
    onChanged?.();
  }

  return (
    <>
      <section className="page-heading">
        <div><p className="eyebrow">Catalog scope</p><h1>Products</h1><p className="page-intro">Choose what StockTrail monitors, scan current evidence, and prepare reviewable improvements.</p></div>
        <ActionButton<DashboardImportResult>
          label="Import catalog"
          busyLabel="Importing…"
          className="primary-action"
          action={() => apiPost('/api/imports', { limit: 250 })}
          successMessage={result => `Imported ${result.productCount} products and ${result.variantCount} variants.`}
          onSuccess={refresh}
        />
      </section>

      <section className="panel product-panel" aria-labelledby="product-list-title">
        <div className="incident-toolbar">
          <div><h2 id="product-list-title">Local catalog</h2><p>{products ? `${filtered.length} product${filtered.length === 1 ? '' : 's'} shown` : 'Loading products'}</p></div>
          <label className="search-field"><span>Search products</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Product title" /></label>
        </div>
        {error ? <ErrorState title="Could not load products" message="The local catalog is unavailable." retry={() => setRevision(value => value + 1)} />
          : products === null ? <LoadingState label="Loading local catalog…" />
            : filtered.length === 0 ? <div className="empty-state compact-empty"><span className="empty-mark" aria-hidden="true">□</span><h3>{products.length ? 'No matching products' : 'No products imported'}</h3><p>{products.length ? 'Try another product title.' : 'Import the local catalog to choose products for monitoring.'}</p></div>
              : <div className="product-list">{filtered.map(product => (
                <article className="product-row" key={product.productGid}>
                  <div className="product-main">
                    <div className="product-title-line"><h3><a href={`#/products/${encodeURIComponent(product.productGid)}`}>{product.title}</a></h3><span className={`state-pill state-pill--${product.present ? 'good' : 'muted'}`}>{product.present ? product.status.toLocaleLowerCase() : 'not present'}</span></div>
                    <p>{product.variantCount} variant{product.variantCount === 1 ? '' : 's'} · {product.inventory.sellableVariants} sellable · {product.openIncidentCount} open incident{product.openIncidentCount === 1 ? '' : 's'}</p>
                    <p className="weakest">Weakest: {weakestLabel(product)}</p>
                  </div>
                  <div className="product-score" aria-label={`Current readiness: ${scoreLabel(product.readinessScore)}`}><span>{product.readinessScore ?? '—'}</span><small>current</small></div>
                  <div className="row-actions">
                    {product.allowedActions.includes(product.monitored ? 'unmonitor' : 'monitor') ? <ActionButton<DashboardMonitoringResult>
                      label={product.monitored ? 'Remove monitoring' : 'Monitor'} busyLabel="Saving…"
                      action={() => apiPost('/api/monitoring', { productId: product.productGid, action: product.monitored ? 'remove' : 'add' })}
                      successMessage={result => `${result.active} of ${result.limit} monitoring slots active.`} onSuccess={refresh}
                    /> : null}
                    <a className="secondary-action" href={`#/products/${encodeURIComponent(product.productGid)}`}>View details</a>
                  </div>
                </article>
              ))}</div>}
      </section>
    </>
  );
}
