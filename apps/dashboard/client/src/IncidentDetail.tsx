import { useEffect, useState } from 'react';
import type { DashboardIncidentDetail } from '../../../../packages/shared/src/dashboard.js';
import { ErrorState, LoadingState } from './ActionButton.js';
import { apiGet } from './api.js';
import { RerunButton } from './RerunButton.js';

const explanations = {
  'ST-001': {
    title: 'Search data overpromises availability',
    cause: 'The variant is unavailable in Shopify, but its structured search data still advertises it as in stock.',
    action: 'Update the product JSON-LD so each offer uses the matched variant’s availability, then rerun this stored test.',
  },
  'ST-002': {
    title: 'The storefront permits a sold-out variant',
    cause: 'Shopify says the matched variant cannot be purchased, but the rendered product form leaves its purchase control enabled.',
    action: 'Review the variant-selection and add-to-cart state in the theme, then rerun this stored test.',
  },
  'ST-003': {
    title: 'The storefront blocks a sellable variant',
    cause: 'Shopify says the matched variant can be purchased, but the rendered product form blocks the shopper.',
    action: 'Review the theme’s variant availability logic and product-form state, then rerun this stored test.',
  },
} as const;

function Perspective(props: { label: string; perspective: DashboardIncidentDetail['comparison'][number]; description: string }) {
  const observed = props.perspective.outcome === 'observed';
  return (
    <article className={`perspective perspective--${observed ? 'observed' : 'inconclusive'}`}>
      <div className="perspective-top"><span>{props.label}</span><strong>{observed ? 'Observed' : 'Inconclusive'}</strong></div>
      <p>{props.description}</p>
      <small>{props.perspective.reasonCode ? props.perspective.reasonCode.replaceAll('_', ' ') : `${props.perspective.itemCount} evidence item${props.perspective.itemCount === 1 ? '' : 's'}${props.perspective.source ? ` from ${props.perspective.source}` : ''}`}</small>
    </article>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export function IncidentDetailView({ incidentId }: { incidentId: string }) {
  const [detail, setDetail] = useState<DashboardIncidentDetail | null>(null);
  const [error, setError] = useState<'not-found' | 'unavailable' | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void apiGet<DashboardIncidentDetail>(`/api/incidents/${incidentId}`, controller.signal)
      .then(value => { if (value) setDetail(value); })
      .catch(value => { if (value?.name !== 'AbortError') setError(value?.code === 'not_found' ? 'not-found' : 'unavailable'); });
    return () => controller.abort();
  }, [incidentId, revision]);

  useEffect(() => {
    if (detail) document.title = `${detail.ruleId} · Incident · StockTrail`;
  }, [detail]);

  if (error) return <ErrorState headingLevel={1} title={error === 'not-found' ? 'Incident not found' : 'Evidence unavailable'} message={error === 'not-found' ? 'This incident is not available for the configured shop.' : 'StockTrail could not read this incident safely.'} />;
  if (!detail) return <LoadingState label="Loading three-perspective evidence…" />;

  const explanation = explanations[detail.ruleId];
  const admin = detail.comparison.find(value => value.perspective === 'admin')!;
  const storefront = detail.comparison.find(value => value.perspective === 'storefront')!;
  const search = detail.comparison.find(value => value.perspective === 'search')!;
  return (
    <>
      <nav className="breadcrumbs" aria-label="Breadcrumb"><a href="#/incidents">Incidents</a><span aria-hidden="true">/</span><span>{detail.ruleId}</span></nav>
      <section className="detail-hero">
        <div>
          <div className="detail-kicker"><span className={`severity severity--${detail.severity}`}>{detail.severity}</span><span className={`incident-status incident-status--${detail.status}`}>{detail.status}</span></div>
          <h1>{explanation.title}</h1>
          <p>{detail.productTitle} <span aria-hidden="true">·</span> {detail.variantLabel}</p>
        </div>
        <div className="detail-actions">
          {detail.productUrl ? <a className="secondary-action" href={detail.productUrl} target="_blank" rel="noreferrer">Open product <span aria-hidden="true">↗</span></a> : null}
          <RerunButton incidentId={incidentId} label="Rerun test" onComplete={() => setRevision(value => value + 1)} />
        </div>
      </section>

      <section aria-labelledby="comparison-title">
        <div className="section-heading"><p className="eyebrow">The proof</p><h2 id="comparison-title">Three perspectives, one variant</h2></div>
        <div className="perspective-grid">
          <Perspective label="Shopify truth" perspective={admin} description="Admin inventory, publication, tracking, and selling policy for the exact variant." />
          <Perspective label="Storefront behavior" perspective={storefront} description="What a shopper encounters after StockTrail selects this exact variant in a clean browser." />
          <Perspective label="Search data" perspective={search} description="The machine-readable availability claim exposed in the product page’s JSON-LD." />
        </div>
      </section>

      <section className="detail-grid">
        <article className="panel cause-card">
          <p className="eyebrow">Likely cause</p>
          <h2>Where the story breaks</h2>
          <p>{explanation.cause}</p>
          <div className="next-action"><strong>Suggested action</strong><span>{explanation.action}</span></div>
        </article>
        <article className="panel evidence-card">
          <p className="eyebrow">Evidence bundle</p>
          <h2>Saved locally</h2>
          <ul>
            {detail.sources.filter(source => source.artifactPath).map(source => (
              <li key={source.source}>
                <span><strong>{source.source}</strong><small>{source.outcome}</small></span>
                <a href={`/api/incidents/${detail.id}/evidence/${source.source}`} target="_blank" rel="noreferrer">View evidence</a>
              </li>
            ))}
          </ul>
          <p className="privacy-note">Evidence never leaves this machine. HTML opens as plain text.</p>
        </article>
      </section>

      <section className="panel history-card" aria-labelledby="history-title">
        <div className="panel-heading"><div><p className="eyebrow">Regression trail</p><h2 id="history-title">Test history</h2></div><span className="muted">First seen {formatDate(detail.firstSeenAt)}</span></div>
        {detail.testHistory.length ? <ol>{detail.testHistory.map(run => <li key={run.runId}><span className={`test-outcome test-outcome--${run.outcome}`}>{run.outcome}</span><span>{run.reasonCode.replaceAll('_', ' ')}</span><time dateTime={run.completedAt}>{formatDate(run.completedAt)}</time></li>)}</ol> : <p className="history-empty">No reruns yet. The incident’s stored assertion is ready to run.</p>}
      </section>
    </>
  );
}
