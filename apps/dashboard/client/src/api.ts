import type { DashboardErrorCode } from '../../../../packages/shared/src/dashboard.js';

type DashboardErrorPayload = { error?: DashboardErrorCode };

const errorMessages: Record<DashboardErrorCode, string> = {
  invalid_host: 'The dashboard address is not valid. Reopen it from the local StockTrail command.',
  invalid_origin: 'This action was blocked because it did not come from this dashboard.',
  invalid_request: 'The request was not valid. Review the fields and try again.',
  invalid_identifier: 'This item has an invalid identifier.',
  unsupported_media_type: 'The dashboard could not send this request safely.',
  body_too_large: 'The request was too large.',
  not_found: 'The requested item is no longer available.',
  method_not_allowed: 'That action is not supported.',
  operation_in_progress: 'This action is already running. Wait for it to finish.',
  conflict: 'The saved data changed. Refresh this page before trying again.',
  confirmation_mismatch: 'The confirmation text did not match.',
  warning_acknowledgement_required: 'Acknowledge the listed risks before applying this proposal.',
  write_scope_required: 'The Shopify connection does not have the required write permission.',
  unprocessable: 'StockTrail could not safely complete this action.',
  artifact_integrity_failed: 'The saved local artifact failed its integrity check.',
  dashboard_unavailable: 'The local dashboard could not complete this request.',
};

export class DashboardApiError extends Error {
  constructor(readonly code: DashboardErrorCode | 'unknown', message?: string) {
    super(message ?? (code === 'unknown' ? 'The local dashboard request failed.' : errorMessages[code]));
    this.name = 'DashboardApiError';
  }
}

async function decode<T>(response: Response): Promise<T> {
  if (response.ok) return response.json() as Promise<T>;
  let payload: DashboardErrorPayload = {};
  try { payload = await response.json() as DashboardErrorPayload; } catch { /* Redact raw server responses. */ }
  const code = payload.error && payload.error in errorMessages ? payload.error : 'unknown';
  throw new DashboardApiError(code);
}

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return decode<T>(await fetch(path, { signal, headers: { Accept: 'application/json' } }));
}

export async function apiPost<T>(path: string, body: object): Promise<T> {
  return decode<T>(await fetch(path, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

export function safeErrorMessage(value: unknown): string {
  return value instanceof DashboardApiError ? value.message : 'The local dashboard could not complete this action.';
}

export function productPath(productGid: string): string {
  return `/api/products/${encodeURIComponent(productGid)}`;
}
