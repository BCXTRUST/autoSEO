import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  FORUM_PASSWORD_LENGTH,
  FORUM_USERNAME_MAX,
  generateForumPassword,
  generateForumUsername,
  simplifyForumUsername,
  type RandomBytes,
} from "./credentials.js";

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

describe("forum credentials", () => {
  it("generates passwords with every character class", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2 ** 31 }), (seed) => {
        const password = generateForumPassword(seeded(seed));
        return (
          password.length === FORUM_PASSWORD_LENGTH &&
          /[a-z]/.test(password) &&
          /[A-Z]/.test(password) &&
          /[0-9]/.test(password) &&
          /[^A-Za-z0-9]/.test(password) &&
          !/[\s"'<>\\]/.test(password)
        );
      }),
    );
  });

  it("does not repeat passwords with the default random source", () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateForumPassword()));
    expect(seen.size).toBe(50);
  });

  it("derives an ASCII username from the persona name", () => {
    const random = seeded(7);
    expect(generateForumUsername("Mira Sol", random)).toMatch(/^mira_sol\d{2}$/);
    expect(simplifyForumUsername("sophie_braun68")).toBe("sophiebraun68");
    expect(generateForumUsername("Jürgen Groß", random)).toMatch(/^jurgen_gross\d{2}$/);
    expect(generateForumUsername("!!!", random)).toMatch(/^member\d{2}$/);
    expect(generateForumUsername("x", random)).toMatch(/^x\d{2}$/);
  });

  it("keeps usernames within platform limits", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 80 }),
        fc.integer({ min: 1, max: 2 ** 31 }),
        (name, seed) => {
          const username = generateForumUsername(name, seeded(seed));
          return (
            username.length >= 3 &&
            username.length <= FORUM_USERNAME_MAX &&
            /^[a-z0-9_]+$/.test(username) &&
            !username.startsWith("_")
          );
        },
      ),
    );
  });
});
