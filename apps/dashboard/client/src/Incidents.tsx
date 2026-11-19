import { useEffect, useMemo, useState } from 'react';
import type { DashboardIncidentSummary } from '../../../../packages/shared/src/dashboard.js';
import { formatTimestamp } from './presentation.js';

type StatusFilter = 'all' | DashboardIncidentSummary['status'];
export type IncidentFilters = { query: string; status: StatusFilter; severity: 'all' | DashboardIncidentSummary['severity']; sort: 'severity' | 'newest' | 'oldest' };

const ruleNames: Record<DashboardIncidentSummary['ruleId'], string> = {
  'ST-001': 'Search availability',
  'ST-002': 'Storefront permits sold-out',
  'ST-003': 'Storefront blocks sellable',
};

export function Incidents({ filters, onFiltersChange }: { filters: IncidentFilters; onFiltersChange: (filters: IncidentFilters) => void }) {
  const { status, query, severity, sort } = filters;
  const [revision, setRevision] = useState(0);
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
  }, [status, revision]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const matches = (incidents ?? []).filter(incident => (severity === 'all' || incident.severity === severity) && (!needle || [
      incident.productTitle, incident.variantLabel, incident.ruleId, ruleNames[incident.ruleId],
    ].some(value => value.toLocaleLowerCase().includes(needle))));
    return matches.sort((a, b) => {
      if (sort === 'severity' && a.severity !== b.severity) return a.severity === 'high' ? -1 : 1;
      const ageDifference = Date.parse(a.firstSeenAt) - Date.parse(b.firstSeenAt);
      return sort === 'oldest' ? ageDifference : -ageDifference;
    });
  }, [incidents, query, severity, sort]);

  const hasFilters = query !== '' || status !== 'all' || severity !== 'all' || sort !== 'severity';
  function clearFilters() { onFiltersChange({ query: '', status: 'all', severity: 'all', sort: 'severity' }); }

  return (
    <>
      <section className="page-heading">
        <div>
          <h1>Inventory issues</h1>
          <p className="page-intro">Every row ties a Shopify fact to conflicting storefront or search evidence.</p>
        </div>
      </section>

      <section className="panel incidents-panel" aria-labelledby="incident-list-title">
        <div className="incident-toolbar">
          <div>
            <h2 id="incident-list-title">Evidence-backed findings</h2>
            <p role="status">{incidents ? `${filtered.length} issue${filtered.length === 1 ? '' : 's'} shown` : 'Loading findings'}</p>
          </div>
          <div className="filters">
            <label>
              <span>Search incidents</span>
              <input type="search" value={query} onChange={event => onFiltersChange({ ...filters, query: event.target.value })} placeholder="Product, variant, or rule" />
            </label>
            <label>
              <span id="issue-status-label">Status</span>
              <select aria-labelledby="issue-status-label" value={status} onChange={event => onFiltersChange({ ...filters, status: event.target.value as StatusFilter })}>
                <option value="all">All statuses</option>
                <option value="open">Open</option>
                <option value="resolved">Resolved</option>
                <option value="ignored">Ignored</option>
              </select>
            </label>
            <label><span id="issue-severity-label">Severity</span><select aria-labelledby="issue-severity-label" value={severity} onChange={event => onFiltersChange({ ...filters, severity: event.target.value as IncidentFilters['severity'] })}><option value="all">All severities</option><option value="high">High</option><option value="medium">Medium</option></select></label>
            <label><span id="issue-sort-label">Sort by</span><select aria-labelledby="issue-sort-label" value={sort} onChange={event => onFiltersChange({ ...filters, sort: event.target.value as IncidentFilters['sort'] })}><option value="severity">Severity, highest first</option><option value="newest">Detected, newest first</option><option value="oldest">Detected, oldest first</option></select></label>
            {hasFilters ? <button className="secondary-action" type="button" onClick={clearFilters}>Clear filters</button> : null}
          </div>
        </div>

        {error ? (
          <div className="inline-state inline-state--stack" role="alert"><strong>Could not load incidents</strong><span>Check that the local dashboard is running, then try again.</span><button className="secondary-action" type="button" onClick={() => setRevision(value => value + 1)}>Try again</button></div>
        ) : incidents === null ? (
          <div className="inline-state" role="status"><span className="loader" aria-hidden="true" /><span>Loading incident evidence…</span></div>
        ) : filtered.length === 0 ? (
          <div className="empty-state compact-empty">
            <span className="empty-mark" aria-hidden="true">✓</span>
            <h3>No matching incidents</h3>
            <p>{hasFilters ? 'Try changing the search, status, or severity filter.' : 'A browser scan will add a row when StockTrail proves a contradiction.'}</p>
            {hasFilters ? <button className="secondary-action" type="button" onClick={clearFilters}>Clear filters</button> : null}
          </div>
        ) : (
          <div className="table-wrap">
            <table role="table" aria-label="Inventory issues">
              <thead><tr><th>Product and variant</th><th>Rule</th><th>Severity</th><th>Status</th><th>Last seen</th><th><span className="sr-only">Open</span></th></tr></thead>
              <tbody>
                {filtered.map(incident => (
                  <tr key={incident.id}>
                    <td data-label="Product"><strong>{incident.productTitle}</strong><span>{incident.variantLabel}</span></td>
                    <td data-label="Rule"><strong>{incident.ruleId}</strong><span>{ruleNames[incident.ruleId]}</span></td>
                    <td data-label="Severity"><span className={`severity severity--${incident.severity}`}>{incident.severity}</span></td>
                    <td data-label="Status"><span className={`incident-status incident-status--${incident.status}`}>{incident.status}</span></td>
                    <td data-label="Last seen"><time dateTime={incident.lastSeenAt}>{formatTimestamp(incident.lastSeenAt)}</time><small>{incident.occurrenceCount} occurrence{incident.occurrenceCount === 1 ? '' : 's'}</small></td>
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
