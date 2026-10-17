import { useEffect, useMemo, useState } from 'react';
import type { DashboardIncidentSummary } from '../../../../packages/shared/src/dashboard.js';

type StatusFilter = 'all' | DashboardIncidentSummary['status'];

const ruleNames: Record<DashboardIncidentSummary['ruleId'], string> = {
  'ST-001': 'Search availability',
  'ST-002': 'Storefront permits sold-out',
  'ST-003': 'Storefront blocks sellable',
};

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));
}

export function Incidents() {
  const [status, setStatus] = useState<StatusFilter>('all');
  const [query, setQuery] = useState('');
  const [incidents, setIncidents] = useState<DashboardIncidentSummary[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setIncidents(null);
    setError(false);
    const suffix = status === 'all' ? '' : `?status=${status}`;
    void fetch(`/api/incidents${suffix}`, { signal: controller.signal })
      .then(response => {
        if (!response.ok) throw new Error('Incident list unavailable.');
        return response.json() as Promise<DashboardIncidentSummary[]>;
      })
      .then(setIncidents)
      .catch(value => { if (value?.name !== 'AbortError') setError(true); });
    return () => controller.abort();
  }, [status]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!incidents || !needle) return incidents ?? [];
    return incidents.filter(incident => [
      incident.productTitle, incident.variantLabel, incident.ruleId, ruleNames[incident.ruleId],
    ].some(value => value.toLocaleLowerCase().includes(needle)));
  }, [incidents, query]);

  return (
    <>
      <section className="page-heading">
        <div>
          <p className="eyebrow">Contradiction ledger</p>
          <h1>Incidents</h1>
          <p className="page-intro">Every row ties a Shopify fact to conflicting storefront or search evidence.</p>
        </div>
      </section>

      <section className="panel incidents-panel" aria-labelledby="incident-list-title">
        <div className="incident-toolbar">
          <div>
            <h2 id="incident-list-title">Evidence-backed findings</h2>
            <p>{incidents ? `${filtered.length} shown` : 'Loading findings'}</p>
          </div>
          <div className="filters">
            <label>
              <span>Search incidents</span>
              <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Product, variant, or rule" />
            </label>
            <label>
              <span>Status</span>
              <select value={status} onChange={event => setStatus(event.target.value as StatusFilter)}>
                <option value="all">All statuses</option>
                <option value="open">Open</option>
                <option value="resolved">Resolved</option>
                <option value="ignored">Ignored</option>
              </select>
            </label>
          </div>
        </div>

        {error ? (
          <div className="inline-state" role="alert"><strong>Could not load incidents</strong><span>Refresh the page or restart the local dashboard.</span></div>
        ) : incidents === null ? (
          <div className="inline-state" role="status"><span className="loader" aria-hidden="true" /><span>Loading incident evidence…</span></div>
        ) : filtered.length === 0 ? (
          <div className="empty-state compact-empty">
            <span className="empty-mark" aria-hidden="true">✓</span>
            <h3>No matching incidents</h3>
            <p>{query || status !== 'all' ? 'Try changing the search or status filter.' : 'A browser scan will add a row when StockTrail proves a contradiction.'}</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Product and variant</th><th>Rule</th><th>Severity</th><th>Status</th><th>Last seen</th><th><span className="sr-only">Open</span></th></tr></thead>
              <tbody>
                {filtered.map(incident => (
                  <tr key={incident.id}>
                    <td data-label="Product"><strong>{incident.productTitle}</strong><span>{incident.variantLabel}</span></td>
                    <td data-label="Rule"><strong>{incident.ruleId}</strong><span>{ruleNames[incident.ruleId]}</span></td>
                    <td data-label="Severity"><span className={`severity severity--${incident.severity}`}>{incident.severity}</span></td>
                    <td data-label="Status"><span className={`incident-status incident-status--${incident.status}`}>{incident.status}</span></td>
                    <td data-label="Last seen"><span>{formatDate(incident.lastSeenAt)}</span><small>{incident.occurrenceCount} occurrence{incident.occurrenceCount === 1 ? '' : 's'}</small></td>
                    <td><a className="row-link" href={`#/incidents/${incident.id}`} aria-label={`Inspect ${incident.productTitle}, ${incident.variantLabel}`}>Inspect <span aria-hidden="true">→</span></a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
