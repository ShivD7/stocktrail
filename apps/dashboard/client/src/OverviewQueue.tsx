import { useEffect, useState } from 'react';
import type { DashboardIncidentSummary, DashboardProductSummary } from '../../../../packages/shared/src/dashboard.js';
import { ErrorState, LoadingState } from './ActionButton.js';
import { apiGet } from './api.js';
import { formatTimestamp } from './presentation.js';

/** These summaries use the existing read APIs; no synthetic activity or inferred approvals. */
export function OverviewQueue({ refreshToken }: { refreshToken: object }) {
  const [issues, setIssues] = useState<DashboardIncidentSummary[] | null>(null);
  const [products, setProducts] = useState<DashboardProductSummary[] | null>(null);
  const [errors, setErrors] = useState({ issues: false, products: false });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setErrors({ issues: false, products: false });
    void apiGet<DashboardIncidentSummary[]>('/api/incidents?status=open', controller.signal).then(setIssues)
      .catch(error => { if (error?.name !== 'AbortError') setErrors(value => ({ ...value, issues: true })); });
    void apiGet<DashboardProductSummary[]>('/api/products', controller.signal).then(setProducts)
      .catch(error => { if (error?.name !== 'AbortError') setErrors(value => ({ ...value, products: true })); });
    return () => controller.abort();
  }, [revision, refreshToken]);
  const recent = [...(issues ?? [])].sort((a, b) => Date.parse(b.firstSeenAt) - Date.parse(a.firstSeenAt)).slice(0, 5);
  const pending = (products ?? []).filter(product => product.latestProposal?.status === 'ready');
  const high = (issues ?? []).filter(issue => issue.severity === 'high').length;
  return <div className="overview-queue">
    <section className="panel queue-panel" aria-labelledby="recent-issues-title">
      <div className="panel-heading"><h2 id="recent-issues-title">Recently detected issues</h2><a className="text-link" href="#/incidents">View all issues</a></div>
      {errors.issues ? <ErrorState title="Findings unavailable" message="Could not read the local issue list." retry={() => setRevision(value => value + 1)} />
        : !issues ? <LoadingState label="Loading recent findings…" />
          : issues.length === 0 ? <div className="empty-state"><h3>No open inventory issues</h3><p>Run a scan from Products to compare the latest observations.</p><a className="secondary-action" href="#/products">Open products</a></div>
            : <><p className="queue-summary"><span className="severity severity--high">{high} high</span><span className="severity severity--medium">{issues.length - high} medium</span><span className="muted">Open findings</span></p><ul className="queue-list">{recent.map(issue => <li key={issue.id}><div><a href={`#/incidents/${issue.id}`}>{issue.productTitle}</a><p>{issue.variantLabel} · <code>{issue.ruleId}</code></p><time dateTime={issue.firstSeenAt}>{formatTimestamp(issue.firstSeenAt)}</time></div><span className={`severity severity--${issue.severity}`}>{issue.severity}</span></li>)}</ul></>}
    </section>
    <section className="panel queue-panel" aria-labelledby="approval-title">
      <div className="panel-heading"><h2 id="approval-title">Awaiting your review</h2>{products && !errors.products ? <span className="muted">{pending.length} latest proposal{pending.length === 1 ? '' : 's'}</span> : null}</div>
      {errors.products ? <ErrorState title="Proposals unavailable" message="Could not read the latest product proposals." retry={() => setRevision(value => value + 1)} />
        : !products ? <LoadingState label="Loading latest proposals…" />
          : pending.length === 0 ? <div className="empty-state"><h3>No latest proposals awaiting review</h3><p>Open a product to prepare a reviewable content improvement.</p><a className="secondary-action" href="#/products">Open products</a></div>
            : <><p className="privacy-note">Latest proposal per product. Review the proposed changes before approving an update.</p><ul className="queue-list">{pending.map(product => <li key={product.productGid}><div><a href={`#/proposals/${product.latestProposal!.id}`}>{product.title}</a><p>{product.latestProposal!.kind === 'revert' ? 'Revert proposal' : 'Content improvement'} · Ready for review</p><time dateTime={product.latestProposal!.createdAt}>{formatTimestamp(product.latestProposal!.createdAt)}</time></div><a className="secondary-action" href={`#/proposals/${product.latestProposal!.id}`}>Review</a></li>)}</ul></>}
    </section>
  </div>;
}
