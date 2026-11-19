import { useEffect, useState } from 'react';
import type { DashboardOverview, DashboardScanResult } from '../../../../packages/shared/src/dashboard.js';
import { ActionButton, ErrorState, LoadingState } from './ActionButton.js';
import { apiGet, apiPost } from './api.js';
import { Connection } from './Connection.js';
import { IncidentDetailView } from './IncidentDetail.js';
import { Incidents, type IncidentFilters } from './Incidents.js';
import { Icon } from './Icon.js';
import { formatTimestamp } from './presentation.js';
import { ProductDetail } from './ProductDetail.js';
import { Products } from './Products.js';
import { ProposalDetail } from './ProposalDetail.js';
import { OverviewQueue } from './OverviewQueue.js';

type Route =
  | { name: 'overview' }
  | { name: 'products' }
  | { name: 'product'; id: string }
  | { name: 'incidents' }
  | { name: 'incident'; id: string }
  | { name: 'proposal'; id: string }
  | { name: 'connection' };

function routeFromHash(): Route {
  const hash = window.location.hash || '#/';
  let match = /^#\/products\/(.+)$/.exec(hash);
  if (match) { try { return { name: 'product', id: decodeURIComponent(match[1]!) }; } catch { return { name: 'products' }; } }
  match = /^#\/incidents\/([0-9a-f-]+)$/.exec(hash);
  if (match) return { name: 'incident', id: match[1]! };
  match = /^#\/proposals\/([0-9a-f-]+)$/.exec(hash);
  if (match) return { name: 'proposal', id: match[1]! };
  if (hash.startsWith('#/products')) return { name: 'products' };
  if (hash.startsWith('#/incidents')) return { name: 'incidents' };
  if (hash.startsWith('#/connection')) return { name: 'connection' };
  return { name: 'overview' };
}

function routeTitle(route: Route): string {
  if (route.name === 'product') return 'Product';
  if (route.name === 'incident') return 'Incident detail';
  if (route.name === 'proposal') return 'Proposal review';
  if (route.name === 'incidents') return 'Inventory issues';
  if (route.name === 'connection') return 'Settings';
  return route.name[0]!.toLocaleUpperCase() + route.name.slice(1);
}

function useRoute(): Route {
  const [route, setRoute] = useState(routeFromHash);
  useEffect(() => {
    const update = () => setRoute(routeFromHash());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => {
    document.title = `${routeTitle(route)} · StockTrail`;
    const focusHeading = () => {
      const heading = document.querySelector<HTMLElement>('#main-content h1');
      if (!heading) return false;
      heading.tabIndex = -1;
      heading.focus();
      return true;
    };
    if (focusHeading()) return;
    const main = document.querySelector('#main-content');
    if (!main) return;
    const observer = new MutationObserver(() => { if (focusHeading()) observer.disconnect(); });
    observer.observe(main, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [route]);
  return route;
}

function MetricCard(props: { label: string; value: number | string; note: string; tone?: 'signal' | 'clear' }) {
  return <article className={`metric-card ${props.tone ? `metric-card--${props.tone}` : ''}`}><p>{props.label}</p><strong>{props.value}</strong><span>{props.note}</span></article>;
}

function Overview({ data, onChanged }: { data: DashboardOverview; onChanged: () => void }) {
  const hasOpenIncidents = data.incidents.open > 0;
  const scored = data.scoreDistribution.buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  return (
    <>
      <section className="page-heading">
        <div><h1>Overview</h1><p className="page-intro">Follow inventory facts from Shopify to the product page and search data.</p></div>
        {data.latestScan ? <ActionButton<DashboardScanResult> label="Scan again" busyLabel="Scanning…" className="primary-action" action={() => apiPost('/api/scans', { productId: data.latestScan!.productGid })} successMessage={result => `Scan ${result.collectionStatus}; readiness ${result.readinessScore ?? 'inconclusive'}.`} onSuccess={onChanged} /> : <a className="primary-action" href="#/products">Choose a product to scan</a>}
      </section>
      <section className="metrics" aria-label="Store summary">
        <a className="metric-link" href="#/incidents" aria-label={`${data.incidents.open} open inventory issues. Review inventory issues.`}><MetricCard label="Open inventory issues" value={data.incidents.open.toLocaleString()} note={hasOpenIncidents ? 'Review inventory issues →' : 'No active contradictions'} tone={hasOpenIncidents ? 'signal' : 'clear'} /></a>
        <MetricCard label="Resolved" value={data.incidents.resolved} note="Verified by a stored test" tone="clear" />
        <MetricCard label="Monitored products" value={`${data.monitoredProducts.active}/${data.monitoredProducts.limit}`} note={`${data.monitoredProducts.selected} selected locally`} />
      </section>
      <div className="overview-grid">
        <section className="panel scan-panel" aria-labelledby="latest-scan-title">
          <div className="panel-heading"><div><h2 id="latest-scan-title">Most recent scan</h2></div>{data.latestScan ? <span className={`status-chip status-chip--${data.latestScan.status}`}>{data.latestScan.status}</span> : null}</div>
          {data.latestScan ? <><div className="latest-scan"><div><p className="scan-product"><a href={`#/products/${encodeURIComponent(data.latestScan.productGid)}`}>{data.latestScan.productTitle}</a></p><p className="muted">Collected <time dateTime={data.latestScan.completedAt}>{formatTimestamp(data.latestScan.completedAt)}</time></p></div><div className="readiness" aria-label={data.latestScan.readinessScore === null ? 'Current readiness inconclusive' : `Current readiness ${data.latestScan.readinessScore} out of 100`}><span>{data.latestScan.readinessScore ?? '—'}</span><small>{data.latestScan.readinessScore === null ? 'Inconclusive' : 'out of 100'}</small></div></div><p className="privacy-note">Readiness summarizes the collected evidence. Review individual findings before deciding what to change.</p></>
            : <div className="empty-state"><span className="empty-mark" aria-hidden="true">◎</span><h3>No scans yet</h3><p>Import the catalog, monitor a product, and run its first browser-backed scan.</p><a className="secondary-action" href="#/products">Open products</a></div>}
        </section>
        <section className="panel distribution" aria-labelledby="distribution-title"><div className="panel-heading"><div><h2 id="distribution-title">Score distribution</h2></div><span className="muted">{scored} scored</span></div><ul>{data.scoreDistribution.buckets.map(bucket => <li key={bucket.minimum}><span>{bucket.minimum}–{bucket.maximum}</span><meter aria-label={`Readiness ${bucket.minimum} to ${bucket.maximum}: ${bucket.count} products`} min="0" max={Math.max(scored, 1)} value={bucket.count}>{bucket.count}</meter><strong>{bucket.count}</strong></li>)}</ul>{data.scoreDistribution.inconclusive ? <p className="privacy-note">{data.scoreDistribution.inconclusive} product{data.scoreDistribution.inconclusive === 1 ? '' : 's'} inconclusive.</p> : null}</section>
      </div>
      <OverviewQueue refreshToken={data} />
    </>
  );
}

function AppShell({ overview, onChanged }: { overview: DashboardOverview; onChanged: () => void }) {
  const route = useRoute();
  const [collapsed, setCollapsed] = useState(() => window.matchMedia('(max-width: 1100px)').matches);
  const [incidentFilters, setIncidentFilters] = useState<IncidentFilters>({ query: '', status: 'all', severity: 'all', sort: 'severity' });
  function toggleNavigation() {
    setCollapsed(value => !value);
    if (collapsed && window.matchMedia('(max-width: 760px)').matches) {
      window.requestAnimationFrame(() => document.querySelector<HTMLElement>('.sidebar nav a')?.focus());
    }
  }
  const section = route.name === 'product' ? 'products' : route.name === 'incident' ? 'incidents' : route.name;
  return (
    <div className={`app-shell${collapsed ? ' app-shell--collapsed' : ''}`}>
      <a
        className="skip-link"
        href="#main-content"
        onClick={event => {
          event.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
      >Skip to content</a>
      <aside className="sidebar" id="primary-sidebar">
        <a className="brand" href="#/" aria-label="StockTrail overview"><span className="brand-mark"><Icon name="trail" /></span><span className="nav-label">StockTrail</span></a>
        <nav aria-label="Primary navigation" onClick={() => { if (window.matchMedia('(max-width: 760px)').matches) setCollapsed(true); }} onKeyDown={event => {
          if (event.key === 'Escape' && window.matchMedia('(max-width: 760px)').matches) {
            setCollapsed(true);
            document.querySelector<HTMLElement>('.menu-button')?.focus();
          }
        }}>
          <a href="#/" aria-label="Overview" aria-current={section === 'overview' ? 'page' : undefined}><Icon name="overview" /><span className="nav-label">Overview</span></a>
          <a href="#/incidents" aria-label="Inventory Issues" aria-current={section === 'incidents' ? 'page' : undefined}><Icon name="issues" /><span className="nav-label">Inventory Issues</span>{overview.incidents.open > 0 ? <span className="nav-count">{overview.incidents.open.toLocaleString()}</span> : null}</a>
          <a href="#/products" aria-label="Products" aria-current={section === 'products' ? 'page' : undefined}><Icon name="products" /><span className="nav-label">Products</span></a>
          <a href="#/connection" aria-label="Settings" aria-current={section === 'connection' ? 'page' : undefined}><Icon name="settings" /><span className="nav-label">Settings</span></a>
        </nav>
        <div className="local-note"><span className="live-dot" aria-hidden="true" /><div><strong>Local only</strong><small>{overview.shop ?? 'No store configured'}</small></div></div>
      </aside>
      <div className="workspace">
      <header className="topbar">
        <div className="topbar-location"><button className="menu-button" type="button" onClick={toggleNavigation} aria-expanded={!collapsed} aria-controls="primary-sidebar" aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}><Icon name="menu" /></button><span>StockTrail <span className="topbar-divider" aria-hidden="true">/</span> <strong>{routeTitle(route)}</strong></span></div>
        <span className="store-context"><span className="local-indicator" aria-hidden="true" /><span className="store-name" title={overview.shop ?? 'No store configured'}>{overview.shop ?? 'No store configured'}</span><span className="local-label">Local workspace</span></span>
      </header>
      <main id="main-content" tabIndex={-1}>
        {route.name === 'overview' ? <Overview data={overview} onChanged={onChanged} />
          : route.name === 'products' ? <Products onChanged={onChanged} />
            : route.name === 'product' ? <ProductDetail key={route.id} productId={route.id} onChanged={onChanged} />
              : route.name === 'incidents' ? <Incidents filters={incidentFilters} onFiltersChange={setIncidentFilters} />
                : route.name === 'incident' ? <IncidentDetailView key={route.id} incidentId={route.id} />
                  : route.name === 'proposal' ? <ProposalDetail key={route.id} proposalId={route.id} onChanged={onChanged} />
                    : <Connection />}
      </main>
      </div>
    </div>
  );
}

export function App() {
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    void apiGet<DashboardOverview>('/api/overview', controller.signal).then(setOverview).catch(value => { if (value?.name !== 'AbortError') setError(true); });
    return () => controller.abort();
  }, [revision]);
  if (error) return <main className="centered-state"><h1>Dashboard unavailable</h1><ErrorState title="Could not load dashboard" message="Restart the local dashboard command and try again." retry={() => setRevision(value => value + 1)} /></main>;
  if (!overview) return <main className="centered-state"><LoadingState label="Loading local evidence…" /></main>;
  return <AppShell overview={overview} onChanged={() => setRevision(value => value + 1)} />;
}
