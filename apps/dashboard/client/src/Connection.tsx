import { useEffect, useState } from 'react';
import type { DashboardConnection } from '../../../../packages/shared/src/dashboard.js';

function StateRow(props: { label: string; value: string; good?: boolean }) {
  return <div className="state-row"><span>{props.label}</span><strong className={props.good ? 'state-good' : undefined}>{props.value}</strong></div>;
}

export function Connection() {
  const [data, setData] = useState<DashboardConnection | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/connection', { signal: controller.signal })
      .then(response => {
        if (!response.ok) throw new Error('Connection data unavailable.');
        return response.json() as Promise<DashboardConnection>;
      })
      .then(setData)
      .catch(value => { if (value?.name !== 'AbortError') setError(true); });
    return () => controller.abort();
  }, []);

  return (
    <>
      <section className="page-heading">
        <div>
          <p className="eyebrow">Local setup</p>
          <h1>Connection</h1>
          <p className="page-intro">Configuration and credentials remain on this machine. StockTrail reports state, never secret values.</p>
        </div>
      </section>
      {error ? <div className="inline-state" role="alert"><strong>Connection status unavailable</strong><span>Restart the local dashboard and try again.</span></div>
        : !data ? <div className="inline-state" role="status"><span className="loader" aria-hidden="true" /><span>Checking local setup…</span></div>
          : <div className="connection-layout">
            <section className="panel connection-card" aria-labelledby="store-connection-title">
              <p className="eyebrow">Shopify Admin</p>
              <h2 id="store-connection-title">Store connection</h2>
              <div className="state-list">
                <StateRow label="Store" value={data.shop ?? 'Not configured'} good={data.configuration === 'ready'} />
                <StateRow label="Configuration" value={data.configuration} good={data.configuration === 'ready'} />
                <StateRow label="OS credential" value={data.credentialStorage} good={data.credentialStorage === 'stored'} />
              </div>
              {data.configuration === 'unconfigured' || data.credentialStorage === 'missing' ? <div className="setup-callout"><strong>Finish setup in the terminal</strong><code>stocktrail init --shop your-store.myshopify.com</code><code>stocktrail connect</code></div> : null}
            </section>

            <section className="panel connection-card" aria-labelledby="catalog-title">
              <p className="eyebrow">Monitoring scope</p>
              <h2 id="catalog-title">Local catalog</h2>
              <div className="catalog-numbers">
                <div><strong>{data.catalog.products}</strong><span>products</span></div>
                <div><strong>{data.catalog.variants}</strong><span>variants</span></div>
                <div><strong>{data.catalog.imports}</strong><span>imports</span></div>
              </div>
              <p className="monitoring-line"><strong>{data.monitoring.active} of {data.monitoring.limit}</strong> monitoring slots active</p>
            </section>

            <section className="panel connection-card data-card" aria-labelledby="local-data-title">
              <div>
                <p className="eyebrow">Privacy and retention</p>
                <h2 id="local-data-title">Local evidence</h2>
                <p>Evidence bundles and the SQLite index stay in StockTrail’s private application-data directory. Retention is manual in this release.</p>
              </div>
              <div className="data-counts">
                <div><strong>{data.localData.evidenceRuns}</strong><span>evidence runs</span></div>
                <div><strong>{data.localData.incidents}</strong><span>incidents</span></div>
                <div><strong>{data.localData.testRuns}</strong><span>test runs</span></div>
              </div>
              <p className="privacy-note">Automatic retention limits and local-data deletion are scheduled for Stage 6. No destructive control is exposed early.</p>
            </section>
          </div>}
    </>
  );
}
