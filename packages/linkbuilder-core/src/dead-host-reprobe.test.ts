import { describe, expect, it } from "vitest";
import { classifySignupTrail, walkDeadHostSignup } from "./dead-host-reprobe.js";

describe("dead host re-probe", () => {
  it("qualifies a register link, a rules step, and a later form", async () => {
    const pages: Record<string, string> = {
      "https://hardwareluxx.de/": '<a href="/register/">Registrieren</a>',
      "https://hardwareluxx.de/register/":
        '<h1>Forumregeln</h1><a href="/register/form">Weiter</a>',
      "https://hardwareluxx.de/register/form":
        '<form><input type="email" name="email"><input type="password" name="password"></form>',
    };
    const seen: string[] = [];
    const verdict = await walkDeadHostSignup({
      homepageUrl: "https://hardwareluxx.de/",
      fetchPage: async (url) => {
        seen.push(url);
        const html = pages[url];
        return html ? { url, html } : null;
      },
    });
    expect(verdict).toBe("qualified");
    expect(seen).toEqual([
      "https://hardwareluxx.de/",
      "https://hardwareluxx.de/register/",
      "https://hardwareluxx.de/register/form",
    ]);
  });

  it("keeps a closed registration and a block dead, and a shop page as form_not_found", () => {
    expect(
      classifySignupTrail([
        { url: "https://shop.example/", html: "<html><title>Shop</title><p>Buy shoes</p></html>" },
      ]),
    ).toBe("form_not_found");
    expect(
      classifySignupTrail([
        {
          url: "https://forum.example/register/",
          html: "<p>Registration is closed</p>",
        },
      ]),
    ).toBe("dead");
    expect(
      classifySignupTrail([
        {
          url: "https://www.google.com/sorry/index",
          html: "<p>unusual traffic</p>",
        },
      ]),
    ).toBe("dead");
  });
});
