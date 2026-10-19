const SECRET_ASSIGNMENT = /\b(authorization|x-shopify-access-token|access[_-]?token|client[_-]?secret|password|secret)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const SHOPIFY_TOKEN = /\bshp[a-z0-9]*_[a-z0-9_-]{8,}\b/gi;
const BEARER_TOKEN = /\bBearer\s+[a-z0-9._~+\/-]+=*/gi;
const URL_CREDENTIALS = /(https?:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi;

/**
 * Last-line defense for user-visible diagnostics. Callers should still avoid
 * placing credentials or private response bodies in Error messages.
 */
export function redactSensitiveText(value: string): string {
  return value
    .replace(BEARER_TOKEN, 'Bearer [REDACTED]')
    .replace(SECRET_ASSIGNMENT, (_match, name: string, separator: string) => `${name}${separator}[REDACTED]`)
    .replace(SHOPIFY_TOKEN, '[REDACTED]')
    .replace(URL_CREDENTIALS, '$1[REDACTED]@');
}

export function safeErrorMessage(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : 'Unexpected error');
}
