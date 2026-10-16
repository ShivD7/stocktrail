import { z } from 'zod';

export const readinessComponentIdSchema = z.enum([
  'availability_agreement',
  'variant_identity',
  'structured_data_quality',
  'inventory_promise_clarity',
  'stale_claim_safety',
]);

export const readinessEvidenceRefSchema = z.object({
  source: z.enum(['admin', 'ajax', 'jsonld', 'browser', 'detector']),
  field: z.string().min(1).max(200),
});

export const readinessComponentSchema = z.object({
  id: readinessComponentIdSchema,
  weight: z.union([z.literal(30), z.literal(25), z.literal(20), z.literal(15), z.literal(10)]),
  outcome: z.enum(['ready', 'not_ready', 'inconclusive']),
  points: z.number().int().nonnegative().nullable(),
  reasonCodes: z.array(z.string().min(1)).min(1),
  evidenceRefs: z.array(readinessEvidenceRefSchema),
}).superRefine((value, context) => {
  const expectedWeights = {
    availability_agreement: 30,
    variant_identity: 25,
    structured_data_quality: 20,
    inventory_promise_clarity: 15,
    stale_claim_safety: 10,
  } as const;
  if (value.weight !== expectedWeights[value.id]) {
    context.addIssue({ code: 'custom', message: 'Readiness component has the wrong fixed weight.' });
  }
  if (value.outcome === 'inconclusive' && value.points !== null) {
    context.addIssue({ code: 'custom', message: 'Inconclusive components cannot award points.' });
  }
  if (value.outcome !== 'inconclusive' && value.points === null) {
    context.addIssue({ code: 'custom', message: 'Conclusive components require points.' });
  }
  if (value.points !== null && value.points !== 0 && value.points !== value.weight) {
    context.addIssue({ code: 'custom', message: 'Component points must be zero or the full weight.' });
  }
});

export const readinessScoreSchema = z.object({
  schemaVersion: z.literal(1),
  total: z.number().int().min(0).max(100).nullable(),
  knownPoints: z.number().int().min(0).max(100),
  knownMax: z.number().int().min(0).max(100),
  components: z.array(readinessComponentSchema).length(5),
  limitation: z.literal('Diagnostic inventory-search readiness; not an SEO ranking claim.'),
}).superRefine((value, context) => {
  if (new Set(value.components.map(component => component.id)).size !== 5) {
    context.addIssue({ code: 'custom', message: 'Every readiness component must appear exactly once.' });
  }
  const conclusive = value.components.filter(component => component.points !== null);
  const points = conclusive.reduce((total, component) => total + component.points!, 0);
  const maximum = conclusive.reduce((total, component) => total + component.weight, 0);
  if (value.knownPoints !== points || value.knownMax !== maximum) {
    context.addIssue({ code: 'custom', message: 'Readiness arithmetic is inconsistent.' });
  }
  const expectedTotal = conclusive.length === 5 ? points : null;
  if (value.total !== expectedTotal) {
    context.addIssue({ code: 'custom', message: 'Readiness total is inconsistent with conclusive components.' });
  }
});

export type ReadinessComponent = z.infer<typeof readinessComponentSchema>;
export type ReadinessScore = z.infer<typeof readinessScoreSchema>;
