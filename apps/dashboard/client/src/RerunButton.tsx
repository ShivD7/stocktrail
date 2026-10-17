import { useState } from 'react';
import type { DashboardRerunResult } from '../../../../packages/shared/src/dashboard.js';

export function RerunButton({ label, onComplete }: { label: string; onComplete?: () => void }) {
  const [state, setState] = useState<'idle' | 'running' | 'complete' | 'error'>('idle');
  const [result, setResult] = useState<DashboardRerunResult | null>(null);

  async function run() {
    setState('running');
    setResult(null);
    try {
      const response = await fetch('/api/tests/rerun', { method: 'POST' });
      if (!response.ok) throw new Error('Rerun unavailable.');
      const value = await response.json() as DashboardRerunResult;
      setResult(value);
      setState('complete');
      onComplete?.();
    } catch {
      setState('error');
    }
  }

  const message = state === 'running' ? 'Collecting fresh evidence…'
    : state === 'error' ? 'Rerun failed. Check the terminal for safe diagnostics.'
      : result?.status === 'no_tests' ? 'No active regression tests to run.'
        : result ? `${result.passed} passed, ${result.failed} failed, ${result.inconclusive} inconclusive.`
          : '';

  return (
    <div className="rerun-control">
      <button className="primary-action" type="button" onClick={() => void run()} disabled={state === 'running'}>
        {state === 'running' ? 'Scanning…' : label} <span aria-hidden="true">↻</span>
      </button>
      {message ? <span className={state === 'error' ? 'action-message action-message--error' : 'action-message'} role="status">{message}</span> : null}
    </div>
  );
}
