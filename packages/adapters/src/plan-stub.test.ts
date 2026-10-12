import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { STARTER_PLAN, StaticPlanProvider, StripePlanStub } from "./plan-stub.js";

const context: AdapterContext = {
  operationId: "plan",
  traceId: "plan",
  workspaceId: "workspace-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

describe("plan stubs", () => {
  it("returns the starter caps and refuses a Stripe webhook", async () => {
    const plan = await new StaticPlanProvider().current("workspace-1", context);
    expect(plan).toEqual(STARTER_PLAN);
    expect(plan.name).toBe("starter");
    expect(plan.caps).toEqual({ projects: 3, live_per_day: 10, personas: 3 });
    const stripe = new StripePlanStub();
    expect(stripe.describe().capabilities.billing).toBe("stub");
    expect(await stripe.current("workspace-1", context)).toEqual(STARTER_PLAN);
    expect(stripe.webhook()).toEqual({ ok: false, reason: "unsigned_webhook_refused" });
  });
});
