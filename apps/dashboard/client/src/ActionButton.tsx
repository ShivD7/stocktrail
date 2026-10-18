import { useState } from 'react';
import { safeErrorMessage } from './api.js';

export type ActionState = 'idle' | 'busy' | 'success' | 'error';

export function ActionButton<T>(props: {
  label: string;
  busyLabel: string;
  action: () => Promise<T>;
  onSuccess?: (result: T) => void;
  successMessage?: string | ((result: T) => string);
  className?: string;
  disabled?: boolean;
}) {
  const [state, setState] = useState<ActionState>('idle');
  const [message, setMessage] = useState('');

  async function run() {
    if (state === 'busy') return;
    setState('busy');
    setMessage('');
    try {
      const result = await props.action();
      setState('success');
      setMessage(typeof props.successMessage === 'function' ? props.successMessage(result) : (props.successMessage ?? 'Action completed.'));
      props.onSuccess?.(result);
    } catch (error) {
      setState('error');
      setMessage(safeErrorMessage(error));
    }
  }

  return (
    <div className="action-control" aria-busy={state === 'busy'}>
      <button
        className={props.className ?? 'secondary-action'}
        type="button"
        onClick={() => void run()}
        disabled={props.disabled || state === 'busy'}
      >
        {state === 'busy' ? props.busyLabel : props.label}
      </button>
      {message ? <span className={`action-message${state === 'error' ? ' action-message--error' : ''}`} role={state === 'error' ? 'alert' : 'status'}>{message}</span> : null}
    </div>
  );
}

export function LoadingState({ label }: { label: string }) {
  return <div className="inline-state" role="status" aria-busy="true"><span className="loader" aria-hidden="true" /><span>{label}</span></div>;
}

export function ErrorState({ title, message, retry, headingLevel }: { title: string; message: string; retry?: () => void; headingLevel?: 1 }) {
  return <div className="inline-state inline-state--stack" role="alert">{headingLevel === 1 ? <h1>{title}</h1> : <strong>{title}</strong>}<span>{message}</span>{retry ? <button className="secondary-action" type="button" onClick={retry}>Try again</button> : null}</div>;
}
