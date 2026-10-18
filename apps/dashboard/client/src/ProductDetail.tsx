import { useEffect, useState } from 'react';
import type {
  DashboardImproveResult,
  DashboardMonitoringResult,
  DashboardProductDetail,
  DashboardScanResult,
} from '../../../../packages/shared/src/dashboard.js';
import { ActionButton, ErrorState, LoadingState } from './ActionButton.js';
import { apiGet, apiPost, productPath } from './api.js';

const componentLabels: Record<string, string> = {
  availability_agreement: 'Availability agreement',
  variant_identity: 'Variant identity',
  structured_data_quality: 'Structured data quality',
  inventory_promise_clarity: 'Inventory promise clarity',
  stale_claim_safety: 'Stale claim safety',
};

const guidanceLabels: Record<string, string> = {
  PV_NO_EFFECT: 'No safe content-only improvement was found.',
  PV_BASE_EVIDENCE_INVALID: 'Collect a complete evidence bundle before creating an improvement.',
  PV_READINESS_REGRESSION: 'The candidate would reduce readiness, so no proposal was created.',
};

export function ProductDetail({ productId, onChanged }: { productId: string; onChanged?: () => void }) {
  const [product, setProduct] = useState<DashboardProductDetail | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<'not-found' | 'unavailable' | null>(null);
  const [guidance, setGuidance] = useState<string[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void apiGet<DashboardProductDetail>(productPath(productId), controller.signal)
      .then(setProduct)
      .catch(value => { if (value?.name !== 'AbortError') setError(value?.code === 'not_found' ? 'not-found' : 'unavailable'); });
    return () => controller.abort();
  }, [productId, revision]);

  useEffect(() => {
    if (product) document.title = `${product.title} · Products · StockTrail`;
  }, [product]);

  function refresh() {
    setRevision(value => value + 1);
    onChanged?.();
  }

  if (error) return <ErrorState headingLevel={1} title={error === 'not-found' ? 'Product not found' : 'Product unavailable'} message={error === 'not-found' ? 'This product is not in the shop-scoped local catalog.' : 'StockTrail could not read this product safely.'} retry={error === 'unavailable' ? refresh : undefined} />;
  if (!product) return <LoadingState label="Loading product evidence…" />;

  return (
    <>
      <nav className="breadcrumbs" aria-label="Breadcrumb"><a href="#/products">Products</a><span aria-hidden="true">/</span><span>{product.title}</span></nav>
      <section className="detail-hero product-hero">
        <div><div className="detail-kicker"><span className={`state-pill state-pill--${product.monitored ? 'good' : 'muted'}`}>{product.monitored ? 'monitored' : 'not monitored'}</span><span className="state-pill">{product.status.toLocaleLowerCase()}</span></div><h1>{product.title}</h1><p>{product.variantCount} variants · {product.openIncidentCount} open incidents</p></div>
        <div className="detail-actions">
          {product.allowedActions.includes(product.monitored ? 'unmonitor' : 'monitor') ? <ActionButton<DashboardMonitoringResult>
            label={product.monitored ? 'Remove monitoring' : 'Monitor'} busyLabel="Saving…"
            action={() => apiPost('/api/monitoring', { productId, action: product.monitored ? 'remove' : 'add' })}
            successMessage={result => `${result.active} of ${result.limit} monitoring slots active.`} onSuccess={refresh}
          /> : null}
          {product.allowedActions.includes('scan') ? <ActionButton<DashboardScanResult>
            label="Scan now" busyLabel="Scanning…" className="primary-action"
            action={() => apiPost('/api/scans', { productId })}
            successMessage={result => `Scan ${result.collectionStatus}; current readiness ${result.readinessScore ?? 'inconclusive'}.`} onSuccess={refresh}
          /> : null}
        </div>
      </section>

      <section className="score-band" aria-label="Readiness summary">
        <div className="score-card"><span>{product.readinessScore ?? '—'}</span><small>Current score</small></div>
        <div className="inventory-summary"><div><strong>{product.inventory.sellableVariants}</strong><span>Sellable</span></div><div><strong>{product.inventory.unavailableVariants}</strong><span>Unavailable</span></div><div><strong>{product.inventory.unknownVariants}</strong><span>Unknown</span></div></div>
      </section>

      <section className="detail-grid product-detail-grid">
        <article className="panel">
          <div className="panel-heading"><div><p className="eyebrow">Diagnostic score</p><h2>Readiness components</h2></div><span className="muted">Current evidence</span></div>
          {product.readiness ? <ul className="component-list">{product.readiness.components.map(component => (
            <li key={component.id}><div><strong>{componentLabels[component.id]}</strong><small>{component.reasonCodes.join(', ').replaceAll('_', ' ').toLocaleLowerCase()}</small></div><span className={`component-outcome component-outcome--${component.outcome}`}>{component.outcome.replace('_', ' ')}</span><b>{component.points === null ? '—' : `${component.points}/${component.weight}`}</b></li>
          ))}</ul> : <div className="empty-state compact-empty"><h3>No readiness score</h3><p>Run a scan to collect the five deterministic components.</p></div>}
          <p className="privacy-note">Diagnostic inventory-search readiness; not an SEO ranking claim.</p>
        </article>
        <aside className="panel product-copy-card">
          <p className="eyebrow">Current product copy</p><h2>Content snapshot</h2>
          <dl><div><dt>SEO title</dt><dd>{product.seo.title ?? 'Not set'}</dd></div><div><dt>SEO description</dt><dd>{product.seo.description ?? 'Not set'}</dd></div><div><dt>Description</dt><dd>{product.descriptionText || 'No description text'}</dd></div></dl>
        </aside>
      </section>

      <section className="panel proposal-callout" aria-labelledby="improve-title">
        <div><p className="eyebrow">Safe content changes</p><h2 id="improve-title">Prepare an improvement</h2><p>StockTrail proposes reviewable text changes only. It never applies a proposal from this screen.</p></div>
        {product.allowedActions.includes('improve') ? <ActionButton<DashboardImproveResult>
          label="Create proposal" busyLabel="Preparing…" className="primary-action"
          action={() => apiPost(`${productPath(productId)}/improve`, {})}
          successMessage={result => result.proposalId ? 'Proposal created and ready for review.' : 'No proposal was created; review the guidance below.'}
          onSuccess={result => { setGuidance(result.guidanceCodes); if (result.proposalId) window.location.hash = `#/proposals/${result.proposalId}`; }}
        /> : product.latestProposal ? <a className="primary-action" href={`#/proposals/${product.latestProposal.id}`}>Review latest proposal</a> : null}
        {guidance.length ? <div className="guidance" role="status"><strong>Guidance</strong><ul>{guidance.map(code => <li key={code}>{guidanceLabels[code] ?? code.replaceAll('_', ' ').toLocaleLowerCase()}</li>)}</ul></div> : null}
      </section>
      {product.latestProposal ? <p className="related-link"><a href={`#/proposals/${product.latestProposal.id}`}>Latest proposal: {product.latestProposal.status}, verification {product.latestProposal.verificationStatus.replace('_', ' ')}</a></p> : null}
    </>
  );
}
