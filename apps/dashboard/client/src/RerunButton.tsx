import { useState } from 'react';
import type { DashboardRerunResult } from '../../../../packages/shared/src/dashboard.js';
import { apiPost, safeErrorMessage } from './api.js';

export function RerunButton({ incidentId, label, onComplete }: { incidentId: string; label: string; onComplete?: () => void }) {
  const [state, setState] = useState<'idle' | 'running' | 'complete' | 'error'>('idle');
  const [result, setResult] = useState<DashboardRerunResult | null>(null);
  const [error, setError] = useState('');

  async function run() {
    if (state === 'running') return;
    setState('running');
    setResult(null);
    setError('');
    try {
      const value = await apiPost<DashboardRerunResult>(`/api/incidents/${incidentId}/rerun`, {});
      setResult(value);
      setState('complete');
      onComplete?.();
    } catch (value) {
      setError(safeErrorMessage(value));
      setState('error');
    }
  }

  const message = state === 'running' ? 'Collecting fresh evidence…'
    : state === 'error' ? error
      : result?.status === 'no_tests' ? 'No active regression tests to run.'
        : result ? `${result.passed} passed, ${result.failed} failed, ${result.inconclusive} inconclusive.`
          : '';

  return (
    <div className="rerun-control">
      <button className="primary-action" type="button" onClick={() => void run()} disabled={state === 'running'}>
        {state === 'running' ? 'Scanning…' : label} <span aria-hidden="true">↻</span>
      </button>
      {message ? <span className={state === 'error' ? 'action-message action-message--error' : 'action-message'} role={state === 'error' ? 'alert' : 'status'}>{message}</span> : null}
    </div>
  );
}
