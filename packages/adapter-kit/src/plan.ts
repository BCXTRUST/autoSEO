import { z } from "zod";
import type { AdapterContext, AdapterDescriptor } from "./types.js";

/** Billing caps. Stripe is later; v1 adapters return these from a stub. */
export const PlanCapsSchema = z
  .object({
    projects: z.number().int().min(0),
    live_per_day: z.number().int().min(0),
    personas: z.number().int().min(0),
  })
  .strict();
export type PlanCaps = z.infer<typeof PlanCapsSchema>;

export const WorkspacePlanSchema = z
  .object({
    name: z.string().min(1),
    caps: PlanCapsSchema,
  })
  .strict();
export type WorkspacePlan = z.infer<typeof WorkspacePlanSchema>;

export interface PlanProviderCapabilities {
  /** v1 has no live billing provider. */
  billing: "stub";
}

export interface PlanProvider {
  describe(): AdapterDescriptor<PlanProviderCapabilities>;
  current(workspaceId: string, context: AdapterContext): Promise<WorkspacePlan>;
}
