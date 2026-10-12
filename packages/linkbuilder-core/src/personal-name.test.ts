import { describe, expect, it } from "vitest";
import { generateForumUsername, type RandomBytes } from "./credentials.js";
import {
  brandNameSources,
  personaNameIsBrandDerived,
  pickPersonalName,
  resolvePersonaDisplayName,
} from "./personal-name.js";

function seeded(seed: number): RandomBytes {
  let state = seed >>> 0 || 1;
  return (length) => {
    const out = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      out[index] = state & 0xff;
    }
    return out;
  };
}

const SHOP = brandNameSources({
  brandName: "Vitaminexpress",
  projectName: "Vitaminexpress",
  slug: "vitaminexpress-3096",
  domains: ["vitaminexpress.org"],
});

describe("personal forum names", () => {
  it("treats the shop, the project, and the domain as the same brand", () => {
    expect(personaNameIsBrandDerived("Vitaminexpress", SHOP)).toBe(true);
    expect(personaNameIsBrandDerived("vitaminexpress47", SHOP)).toBe(true);
    expect(personaNameIsBrandDerived("Vitamin Express", SHOP)).toBe(true);
    expect(personaNameIsBrandDerived("", SHOP)).toBe(true);
    expect(personaNameIsBrandDerived("Persona", SHOP)).toBe(true);
    expect(personaNameIsBrandDerived("Lena Meier", SHOP)).toBe(false);
  });

  it("replaces a brand label with a German personal name", () => {
    const name = resolvePersonaDisplayName({
      displayName: "Vitaminexpress",
      language: "de",
      sources: SHOP,
      randomBytes: seeded(11),
    });
    expect(name).toMatch(/^[A-ZÄÖÜ][a-zäöüß]+ [A-ZÄÖÜ][a-zäöüß]+$/);
    expect(name.toLowerCase()).not.toMatch(/vitamin|express/);
    expect(personaNameIsBrandDerived(name, SHOP)).toBe(false);
    const username = generateForumUsername(name, seeded(11));
    expect(username).not.toMatch(/vitamin|express/);
    expect(username).not.toBe("vitaminexpress47");
  });

  it("keeps a name the operator already chose", () => {
    expect(
      resolvePersonaDisplayName({
        displayName: "Jonas Hartmann",
        language: "de",
        sources: SHOP,
        randomBytes: seeded(3),
      }),
    ).toBe("Jonas Hartmann");
  });

  it("picks from the language of the market", () => {
    const german = pickPersonalName("de", seeded(4));
    const english = pickPersonalName("en", seeded(4));
    expect(german).toMatch(/^[A-ZÄÖÜ][\p{L}]+ [A-ZÄÖÜ][\p{L}]+$/u);
    expect(english).toMatch(/^[A-Za-z]+ [A-Za-z]+$/);
    expect(german).not.toBe(english);
  });
});
