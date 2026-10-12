import { describe, expect, it } from "vitest";
import {
  creditBalanceAfterSpend,
  FIXTURE_DEMO_SLUG,
  isExampleRegistrableDomain,
  settleCreditPurchase,
  showHostToCustomer,
} from "./customer-hosts.js";
import { IllegalTransition } from "./errors.js";
import { isFixtureHostDomain } from "./fake-scenario.js";
import { hostState } from "./host-state.js";
import {
  DEFAULT_MIN_POSTS_BEFORE_LINK,
  initialWorkState,
  stageFromActivity,
  transitionHostAfterResearch,
  transitionHostForLink,
  transitionWork,
} from "./work-stage.js";

describe("work stage", () => {
  it("refuses register before research", () => {
    expect(() => transitionWork(initialWorkState(), "register")).toThrow(IllegalTransition);
    expect(() => transitionHostAfterResearch("qualified", "registration_started", false)).toThrow(
      IllegalTransition,
    );
    expect(() => transitionHostAfterResearch("discovered", "registration_started", true)).toThrow(
      IllegalTransition,
    );
    const researched = transitionWork(initialWorkState(), "research_complete");
    expect(transitionWork(researched, "register").stage).toBe("warmup");
    expect(
      transitionHostAfterResearch(hostState("qualified"), "registration_started", true).status,
    ).toBe("registering");
  });

  it("refuses a link on the first post while warmup is on", () => {
    expect(DEFAULT_MIN_POSTS_BEFORE_LINK).toBe(3);
    let state = transitionWork(initialWorkState(), "research_complete");
    state = transitionWork(state, "register");
    expect(() => transitionWork(state, "place")).toThrow(IllegalTransition);
    expect(() => transitionHostForLink("ready", "link_counted", { warmupPosts: 0 })).toThrow(
      IllegalTransition,
    );
    expect(() =>
      transitionHostForLink("ready", "link_counted", { warmupPosts: 1, minPostsBeforeLink: 3 }),
    ).toThrow(IllegalTransition);
    state = transitionWork(state, "warmup_post");
    state = transitionWork(state, "warmup_post");
    expect(state.stage).toBe("warmup");
    state = transitionWork(state, "warmup_post");
    expect(state).toMatchObject({ stage: "place", warmupPosts: 3 });
    expect(transitionWork(state, "place").stage).toBe("verify");
    expect(transitionHostForLink("ready", "link_counted", { warmupPosts: 3 }).status).toBe("used");
  });

  it("places on the first post only when warmup is turned off", () => {
    let state = transitionWork(initialWorkState(), "research_complete");
    state = transitionWork(state, "register", { minPostsBeforeLink: 0 });
    expect(state.stage).toBe("place");
    expect(transitionWork(state, "place", { minPostsBeforeLink: 0 }).stage).toBe("verify");
    expect(
      transitionHostForLink("ready", "link_counted", { warmupPosts: 0, minPostsBeforeLink: 0 })
        .status,
    ).toBe("used");
  });

  it("starts an open run at research", () => {
    expect(
      stageFromActivity({
        runStatus: "running",
        lastAction: "Researching",
        stepKinds: ["discover"],
      }),
    ).toBe("research");
    expect(
      stageFromActivity({ runStatus: "running", lastAction: "Posted", stepKinds: ["post"] }),
    ).toBe("place");
  });

  it("moves past a stale research line when a later step exists", () => {
    expect(
      stageFromActivity({
        runStatus: "running",
        lastAction: "Researching",
        stepKinds: ["research", "lb_register"],
      }),
    ).toBe("register");
    expect(
      stageFromActivity({
        runStatus: "running",
        lastAction: "Researching topics",
        stepKinds: ["research", "lb_warmup"],
      }),
    ).toBe("warmup");
    expect(
      stageFromActivity({ runStatus: "running", lastAction: "Place", stepKinds: ["lb_place"] }),
    ).toBe("place");
    expect(
      stageFromActivity({ runStatus: "running", lastAction: "Verify", stepKinds: ["lb_verify"] }),
    ).toBe("verify");
  });
});

describe("customer hosts", () => {
  it("does not treat fixture boards as a customer's hosts", () => {
    expect(isFixtureHostDomain("brett-1ej2xe.example")).toBe(true);
    expect(isFixtureHostDomain("forum-1ej2xe.example")).toBe(true);
    expect(isFixtureHostDomain("fragen-1ej2xe.example")).toBe(true);
    expect(showHostToCustomer("brett-1ej2xe.example", "vitaminexpress")).toBe(false);
    expect(showHostToCustomer("fragen.nordlicht.example", "vitaminexpress")).toBe(false);
    expect(showHostToCustomer("fragen.nordlicht.example", FIXTURE_DEMO_SLUG)).toBe(true);
    expect(showHostToCustomer("www.vitaminexpress.org", "vitaminexpress")).toBe(true);
    expect(isExampleRegistrableDomain("nordlicht.example")).toBe(true);
  });

  it("does not add credits unless a live charge exists", () => {
    expect(creditBalanceAfterSpend(4)).toBe(76);
    const stub = settleCreditPurchase({
      billing: "stub",
      balance: 76,
      chargeId: null,
      amount: 50,
    });
    expect(stub).toEqual({
      balance: 76,
      charged: false,
      reason: "A payment provider is not connected. No card is charged.",
    });
    expect(
      settleCreditPurchase({ billing: "live", balance: 76, chargeId: null, amount: 50 }).charged,
    ).toBe(false);
    expect(
      settleCreditPurchase({ billing: "live", balance: 76, chargeId: "ch_123", amount: 50 }),
    ).toEqual({ balance: 126, charged: true, reason: "" });
  });
});
