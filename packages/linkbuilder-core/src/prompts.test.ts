import { describe, expect, it } from "vitest";
import { DRAFT_MAX_TOKENS, trimReply } from "./drafting.js";
import { draftPrompt } from "./prompts.js";

describe("draft prompt", () => {
  it("names the JSON keys the drafter must return", () => {
    const prompt = draftPrompt({
      displayName: "Mira",
      bio: "",
      register: "du",
      language: "de",
      country: "DE",
      toneNotes: "",
      facts: [],
      targets: [],
      title: "Magnesium",
      excerpt: "Krämpfe",
      citeSource: false,
      maxChars: 400,
    });
    expect(prompt.user).toContain('"body"');
    expect(prompt.user).toContain("at most 400 characters");
    expect(prompt.user).toContain("Do not mention a shop");
    const long = `${"Krämpfe im Fuß kenne ich. ".repeat(40)}Noch ein Satz.`;
    const trimmed = trimReply(long, 80);
    expect([...trimmed].length).toBeLessThanOrEqual(80);
    expect(trimmed.endsWith(".")).toBe(true);
    expect(prompt.user).toContain("linkSlot");
    expect(prompt.user).toContain("Do not state a number");
    expect(DRAFT_MAX_TOKENS).toBeGreaterThanOrEqual(4_000);
  });
});
