import type { AdapterContext, PlanProvider, WorkspacePlan } from "@rakazo/adapter-kit";
import { WorkspacePlanSchema } from "@rakazo/adapter-kit";

/**
 * Named plan returned until billing is connected. Caps are projects, live links per project
 * per day, and personas (one persona per project in v1).
 */
export const STARTER_PLAN: WorkspacePlan = WorkspacePlanSchema.parse({
  name: "starter",
  caps: { projects: 3, live_per_day: 10, personas: 3 },
});

/** Static plan. No Stripe SDK and no network. */
export class StaticPlanProvider implements PlanProvider {
  constructor(private readonly plan: WorkspacePlan = STARTER_PLAN) {
    this.plan = WorkspacePlanSchema.parse(plan);
  }

  describe() {
    return {
      id: "static-plan",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { billing: "stub" as const },
    };
  }

  current(_workspaceId: string, _context: AdapterContext): Promise<WorkspacePlan> {
    return Promise.resolve(this.plan);
  }
}

/**
 * Stripe is not connected. This stub returns the same static plan and refuses every webhook,
 * including unsigned ones. There is no billing route.
 */
export class StripePlanStub extends StaticPlanProvider {
  override describe() {
    return {
      id: "stripe-plan-stub",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { billing: "stub" as const },
    };
  }

  webhook(): { ok: false; reason: "unsigned_webhook_refused" } {
    return { ok: false, reason: "unsigned_webhook_refused" };
  }
}
