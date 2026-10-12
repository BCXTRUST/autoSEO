import { describe, expect, it } from "vitest";
import { probePages, sampleForumHtml, settleProbe } from "./probe.js";

const platforms = [
  "phpbb",
  "woltlab",
  "xenforo",
  "ips",
  "vbulletin",
  "mybb",
  "discourse",
  "flarum",
  "nodebb",
  "vanilla",
] as const;

describe("probePages", () => {
  it.each(platforms)("detects %s from its footprint", (platform) => {
    const html = sampleForumHtml({ platform });
    const facts = probePages({
      homepageUrl: "https://board.example/",
      pages: [{ url: "https://board.example/", html }],
    });
    expect(facts.platform).toBe(platform);
    expect(facts.registerUrl).toContain("board.example");
    expect(settleProbe(facts, true).status).toBe("qualified");
  });

  it.each(["funcaptcha", "geetest"] as const)("keeps %s for the HTTPS door", (captcha) => {
    const facts = probePages({
      homepageUrl: "https://board.example/",
      pages: [
        {
          url: "https://board.example/",
          html: sampleForumHtml({ platform: "phpbb", captcha }),
        },
      ],
    });
    expect(facts.captchaUnsupported).toBe(false);
    expect(facts.captchaType).toBe(captcha);
    expect(settleProbe(facts, true).status).toBe("qualified");
  });

  it.each(["keycaptcha"] as const)("sends %s straight to unsupported_captcha", (captcha) => {
    const facts = probePages({
      homepageUrl: "https://board.example/",
      pages: [
        {
          url: "https://board.example/",
          html: sampleForumHtml({ platform: "phpbb", captcha }),
        },
      ],
    });
    expect(settleProbe(facts, true)).toMatchObject({
      status: "unsupported_captcha",
      reason: "unsupported_captcha",
    });
  });

  it("denies a board whose rules forbid commercial links", () => {
    const facts = probePages({
      homepageUrl: "https://board.example/",
      pages: [
        {
          url: "https://board.example/",
          html: sampleForumHtml({ platform: "woltlab", commercialBan: true }),
        },
      ],
    });
    expect(facts.hrefForNewMembers).toBe("no");
    expect(settleProbe(facts, true).status).toBe("denied");
  });

  it("reads nofollow from a low-post-count member", () => {
    const facts = probePages({
      homepageUrl: "https://board.example/",
      pages: [
        {
          url: "https://board.example/",
          html: sampleForumHtml({ platform: "discourse", rel: "nofollow" }),
        },
      ],
    });
    expect(facts.hrefForNewMembers).toBe("yes");
    expect(facts.relDefault).toBe("nofollow");
  });
});
