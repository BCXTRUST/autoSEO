import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AUX_MODEL_ID,
  DEFAULT_OPENROUTER_MODEL_ID,
  LEGACY_FLASH_MODEL_ID,
  resolveAuxOpenRouterModelId,
  resolveOpenRouterModelId,
} from "./model-defaults.js";

describe("openrouter model defaults", () => {
  it("uses Grok 4.6 instead of DeepSeek flash", () => {
    vi.stubEnv("PI_DEFAULT_MODEL", "");
    expect(DEFAULT_OPENROUTER_MODEL_ID).toBe("x-ai/grok-4.6");
    expect(resolveOpenRouterModelId(undefined)).toBe("x-ai/grok-4.6");
    expect(resolveOpenRouterModelId(LEGACY_FLASH_MODEL_ID)).toBe("x-ai/grok-4.6");
    expect(resolveOpenRouterModelId("scripted")).toBe("scripted");
    expect(resolveOpenRouterModelId("openai/gpt-4o-mini")).toBe("x-ai/grok-4.6");
    expect(resolveOpenRouterModelId("aion-2.0")).toBe("x-ai/grok-4.6");
    expect(resolveOpenRouterModelId("stealth/aion-2.0")).toBe("x-ai/grok-4.6");
    expect(resolveOpenRouterModelId("openai/gpt-4o")).toBe("openai/gpt-4o");
    vi.unstubAllEnvs();
  });

  it("honors PI_DEFAULT_MODEL when replacing flash", () => {
    vi.stubEnv("PI_DEFAULT_MODEL", "x-ai/grok-4.6");
    expect(resolveOpenRouterModelId(LEGACY_FLASH_MODEL_ID)).toBe("x-ai/grok-4.6");
    vi.unstubAllEnvs();
  });

  it("prefers PI_COMPUTER_MODEL over PI_DEFAULT_MODEL for computer remaps", () => {
    vi.stubEnv("PI_COMPUTER_MODEL", "x-ai/grok-4.6");
    vi.stubEnv("PI_DEFAULT_MODEL", "x-ai/grok-4-fast");
    expect(resolveOpenRouterModelId(LEGACY_FLASH_MODEL_ID)).toBe("x-ai/grok-4.6");
    vi.unstubAllEnvs();
  });

  it("uses Gemini Flash for aux work unless PI_AUX_MODEL is set", () => {
    vi.stubEnv("PI_AUX_MODEL", "");
    expect(DEFAULT_AUX_MODEL_ID).toBe("google/gemini-2.5-flash");
    expect(resolveAuxOpenRouterModelId(undefined)).toBe("google/gemini-2.5-flash");
    expect(resolveAuxOpenRouterModelId(DEFAULT_OPENROUTER_MODEL_ID)).toBe(
      "google/gemini-2.5-flash",
    );
    expect(resolveAuxOpenRouterModelId("moonshotai/kimi-k2")).toBe("moonshotai/kimi-k2");
    vi.stubEnv("PI_AUX_MODEL", "x-ai/grok-4-fast");
    expect(resolveAuxOpenRouterModelId("moonshotai/kimi-k2")).toBe("x-ai/grok-4-fast");
    vi.unstubAllEnvs();
  });
});
