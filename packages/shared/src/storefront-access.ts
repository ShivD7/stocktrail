import { z } from 'zod';

/** Safe diagnostics only: no URLs, cookies, request bodies, or server messages. */
export const storefrontAuthDiagnosticSchema = z.object({
  stage: z.enum(['network', 'timeout', 'password_page', 'password_form', 'password_submission', 'redirect', 'session']),
  status: z.number().int().min(100).max(599).nullable(),
}).strict();
export type StorefrontAuthDiagnostic = z.infer<typeof storefrontAuthDiagnosticSchema>;
