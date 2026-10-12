import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEXT_MODEL_LANES,
  lanesFromEnv,
  OPENROUTER_TEXT_TIMEOUT_MS,
} from "./openrouter-text-model.js";

describe("link builder model lanes", () => {
  it("drafts with Gemini 3.8 Flash unless the deployment overrides it", () => {
    expect(DEFAULT_TEXT_MODEL_LANES).toEqual({
      draft: "google/gemini-3.8-flash",
      classify: "google/gemini-3.8-flash",
      fallback: "moonshotai/kimi-k3",
    });
    expect(
      lanesFromEnv({
        LINK_BUILDER_MODEL_DRAFT: "anthropic/claude-fable-5",
      }).draft,
    ).toBe("anthropic/claude-fable-5");
    expect(lanesFromEnv({}).classify).toBe("google/gemini-3.8-flash");
    expect(OPENROUTER_TEXT_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
  });
});
