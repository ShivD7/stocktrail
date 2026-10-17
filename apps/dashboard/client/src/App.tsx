import { useEffect, useState } from 'react';
import type { DashboardOverview } from '../../../../packages/shared/src/dashboard.js';

export function App() {
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [error, setError] = useState(false);

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
  }, []);

  return (
    <main className="bootstrap-shell">
      <p className="eyebrow">Local inventory intelligence</p>
      <h1>StockTrail</h1>
      {error ? <p role="alert">The local dashboard data is unavailable.</p> : null}
      {!error && !overview ? <p role="status">Loading dashboard…</p> : null}
      {overview ? <p>Connected locally{overview.shop ? ` to ${overview.shop}` : ''}.</p> : null}
    </main>
  );
}
