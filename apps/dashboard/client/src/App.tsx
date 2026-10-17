import { useEffect, useState } from 'react';
import type { DashboardOverview } from '../../../../packages/shared/src/dashboard.js';
import { Incidents } from './Incidents.js';
import { IncidentDetailView } from './IncidentDetail.js';
import { RerunButton } from './RerunButton.js';

type Route = 'overview' | 'incidents' | 'connection';

function routeFromHash(): Route {
  if (window.location.hash.startsWith('#/incidents')) return 'incidents';
  if (window.location.hash.startsWith('#/connection')) return 'connection';
  return 'overview';
}

function useRoute(): Route {
  const [route, setRoute] = useState(routeFromHash);
  useEffect(() => {
    const update = () => setRoute(routeFromHash());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return route;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(value));
}

function MetricCard(props: { label: string; value: number | string; note: string; tone?: 'signal' | 'clear' }) {
  return (
    <article className={`metric-card ${props.tone ? `metric-card--${props.tone}` : ''}`}>
      <p>{props.label}</p>
      <strong>{props.value}</strong>
      <span>{props.note}</span>
    </article>
  );
}

function Overview({ data, onRerun }: { data: DashboardOverview; onRerun: () => void }) {
  const hasOpenIncidents = data.incidents.open > 0;
  return (
    <>
      <section className="page-heading">
        <div>
          <p className="eyebrow">Storefront truth, at a glance</p>
          <h1>Overview</h1>
          <p className="page-intro">Follow inventory facts from Shopify to the product page and search data.</p>
        </div>
        <RerunButton label="Scan now" onComplete={onRerun} />
      </section>

      <section className="metrics" aria-label="Store summary">
        <MetricCard
          label="Open contradictions"
          value={data.incidents.open}
          note={hasOpenIncidents ? 'Needs review' : 'No active contradictions'}
          tone={hasOpenIncidents ? 'signal' : 'clear'}
        />
        <MetricCard label="Resolved" value={data.incidents.resolved} note="Verified by a stored test" tone="clear" />
        <MetricCard
          label="Monitored products"
          value={`${data.monitoredProducts.active}/${data.monitoredProducts.limit}`}
          note={`${data.monitoredProducts.selected} selected locally`}
        />
      </section>

      <section className="panel scan-panel" aria-labelledby="latest-scan-title">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Latest evidence</p>
            <h2 id="latest-scan-title">Most recent scan</h2>
          </div>
          {data.latestScan ? <span className={`status-chip status-chip--${data.latestScan.status}`}>{data.latestScan.status}</span> : null}
        </div>
        {data.latestScan ? (
          <div className="latest-scan">
            <div>
              <p className="scan-product">{data.latestScan.productTitle}</p>
              <p className="muted">Collected {formatTime(data.latestScan.completedAt)}</p>
            </div>
            <div className="readiness" aria-label={data.latestScan.readinessScore === null ? 'Readiness inconclusive' : `Readiness ${data.latestScan.readinessScore} out of 100`}>
              <span>{data.latestScan.readinessScore ?? '—'}</span>
              <small>readiness</small>
            </div>
          </div>
        ) : (
          <div className="empty-state">
            <span className="empty-mark" aria-hidden="true">◎</span>
            <h3>No scans yet</h3>
            <p>Run a browser scan from the CLI to collect the first three-perspective evidence bundle.</p>
            <code>stocktrail scan --browser --product-id &lt;gid&gt;</code>
          </div>
        )}
      </section>
    </>
  );
}

function Placeholder({ route }: { route: Exclude<Route, 'overview'> }) {
  return (
    <section className="page-heading">
      <div>
        <p className="eyebrow">Stage 5</p>
        <h1>{route === 'incidents' ? 'Incidents' : 'Connection'}</h1>
        <p className="page-intro">This dashboard view is being connected to the local evidence model.</p>
      </div>
    </section>
  );
}

function AppShell({ data, onRerun }: { data: DashboardOverview; onRerun: () => void }) {
  const route = useRoute();
  const detailMatch = /^#\/incidents\/([0-9a-f-]+)$/.exec(window.location.hash);
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <aside className="sidebar">
        <a className="brand" href="#/" aria-label="StockTrail overview">
          <span className="brand-mark" aria-hidden="true">S</span>
          <span>StockTrail</span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#/" aria-current={route === 'overview' ? 'page' : undefined}>Overview</a>
          <a href="#/incidents" aria-current={route === 'incidents' ? 'page' : undefined}>Incidents</a>
          <a href="#/connection" aria-current={route === 'connection' ? 'page' : undefined}>Connection</a>
        </nav>
        <div className="local-note">
          <span className="live-dot" aria-hidden="true" />
          <div><strong>Local only</strong><small>{data.shop ?? 'No store configured'}</small></div>
        </div>
      </aside>
      <main id="main-content" tabIndex={-1}>
        {route === 'overview' ? <Overview data={data} onRerun={onRerun} />
          : route === 'incidents' && detailMatch?.[1] ? <IncidentDetailView incidentId={detailMatch[1]} />
            : route === 'incidents' ? <Incidents /> : <Placeholder route={route} />}
      </main>
    </div>
  );
}

export function App() {
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/overview', { signal: controller.signal })
      .then(response => {
        if (!response.ok) throw new Error('Dashboard data unavailable.');
        return response.json() as Promise<DashboardOverview>;
      })
      .then(setOverview)
      .catch(value => { if (value?.name !== 'AbortError') setError(true); });
    return () => controller.abort();
  }, [revision]);

  if (error) {
    return <main className="centered-state"><p className="eyebrow">Local service</p><h1>Dashboard unavailable</h1><p role="alert">StockTrail could not read the local dashboard data. Restart the command and try again.</p></main>;
  }
  if (!overview) {
    return <main className="centered-state" aria-busy="true"><span className="loader" aria-hidden="true" /><p role="status">Loading local evidence…</p></main>;
  }
  return <AppShell data={overview} onRerun={() => setRevision(value => value + 1)} />;
}
