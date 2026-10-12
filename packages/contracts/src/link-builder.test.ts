import { describe, expect, it } from "vitest";
import {
  LB_DEFAULT_MARKET,
  LB_DEFAULT_SPAM_SENTENCES,
  LbLanguageSchema,
  LbLinkRatioSchema,
  LbMarketSchema,
  LbProjectConfigSchema,
  LbProjectStartableSchema,
  LbQuotasSchema,
  LbScheduleSchema,
  LbTargetSchema,
  LbDraftReplySchema,
  LbThreadRelevanceSchema,
  LbWhyNotSchema,
  lbPrimaryLanguage,
} from "./index.js";

const minimal = {
  name: "Demo",
  slug: "demo-wellness",
  brandName: "Demo Wellness",
  allowedDomains: ["demo-wellness.example"],
  persona: { displayName: "Lena" },
  quotas: { newPerDay: 3, livePerDay: 1 },
  schedule: { timezone: "Europe/Berlin" },
};

describe("link builder model replies", () => {
  it("accepts a relevance score without reasons and a reply that names the body text", () => {
    expect(LbThreadRelevanceSchema.parse({ relevance: 0.75, openQuestion: true })).toEqual({
      relevance: 0.75,
      openQuestion: true,
      reasons: [],
    });
    expect(
      LbDraftReplySchema.parse({
        answer: "Magnesiumcitrat hat bei Krämpfen geholfen.",
      }),
    ).toMatchObject({ body: "Magnesiumcitrat hat bei Krämpfen geholfen.", linkSlot: "none" });
  });
});

describe("link builder project config", () => {
  it("applies the plan defaults, including undisclosed persona mode", () => {
    const config = LbProjectConfigSchema.parse(minimal);
    expect(config.disclosureMode).toBe("undisclosed_persona");
    expect(config.persona).toEqual({ displayName: "Lena", register: "du", bio: "" });
    expect(config.markets).toEqual([
      { country: "DE", language: "de", locale: "de-DE", timezoneId: "Europe/Berlin" },
    ]);
    expect(config.marketPolicy).toBe("primary_first");
    expect(config.schedule).toEqual({
      timezone: "Europe/Berlin",
      weekdaysOnly: true,
      window: { start: "09:00", end: "22:00" },
      overtimeUntilLiveMet: false,
      hardStopHour: 24,
    });
    expect(config.quotas.maxLivePerHost).toBe(1);
    expect(config.linkRatio).toEqual({ links: 1, posts: 3 });
    expect(config.warmup).toEqual({ minPostsBeforeLink: 3, minAccountAgeHours: 24 });
    expect(config.spamRetry).toEqual({ maxRetries: 1, sentences: [...LB_DEFAULT_SPAM_SENTENCES] });
    expect(config.operator.parkedHostTtlHours).toBe(48);
    expect(config.captchaLowBalanceCredits).toBe(500);
    expect(config.countNofollow).toBe(true);
  });

  it("accepts markets in any country and keeps their order", () => {
    const markets = [
      { country: "BR", language: "pt", locale: "pt-BR", timezoneId: "America/Sao_Paulo" },
      { country: "US", language: "en", locale: "en-US", timezoneId: "America/New_York" },
      { country: "CH", language: "fr", locale: "fr-CH", timezoneId: "Europe/Zurich" },
      { country: "TW", language: "zh", locale: "zh-Hant-TW", timezoneId: "Asia/Taipei" },
    ];
    const config = LbProjectConfigSchema.parse({
      ...minimal,
      markets,
      marketPolicy: "all_markets",
    });
    expect(config.markets.map((market) => market.country)).toEqual(["BR", "US", "CH", "TW"]);
  });

  it("rejects incoherent, malformed or duplicate markets", () => {
    const de = { country: "DE", language: "de", locale: "de-DE", timezoneId: "Europe/Berlin" };
    const bad = [
      { ...de, country: "de" },
      { ...de, country: "DEU" },
      { ...de, language: "German" },
      { ...de, locale: "de-de" },
      { ...de, locale: "en-DE" },
      { ...de, locale: "de-AT" },
      { ...de, timezoneId: "Europe/Atlantis" },
    ];
    for (const market of bad) {
      expect(LbMarketSchema.safeParse(market).success, JSON.stringify(market)).toBe(false);
    }
    expect(LbMarketSchema.safeParse({ ...de, locale: "de" }).success).toBe(true);
    expect(LbProjectConfigSchema.safeParse({ ...minimal, markets: [] }).success).toBe(false);
    expect(LbProjectConfigSchema.safeParse({ ...minimal, markets: [de, de] }).success).toBe(false);
    expect(
      LbProjectConfigSchema.safeParse({
        ...minimal,
        markets: [de, { ...de, language: "en", locale: "en-DE" }],
      }).success,
    ).toBe(true);
    expect(
      LbProjectConfigSchema.safeParse({ ...minimal, marketPolicy: "dach_first" }).success,
    ).toBe(false);
  });

  it("does not share the default markets array between parses", () => {
    const first = LbProjectConfigSchema.parse(minimal);
    first.markets[0] = { ...first.markets[0]!, country: "AT" };
    expect(LbProjectConfigSchema.parse(minimal).markets[0]?.country).toBe("DE");
    expect(LB_DEFAULT_MARKET.country).toBe("DE");
  });

  it("derives the primary language subtag", () => {
    expect(lbPrimaryLanguage("pt-BR")).toBe("pt");
    expect(lbPrimaryLanguage("de")).toBe("de");
    expect(LbLanguageSchema.safeParse("en-GB").success).toBe(true);
  });

  it("requires a mailbox and topic lanes before start", () => {
    expect(LbProjectStartableSchema.safeParse(minimal).success).toBe(false);
    expect(
      LbProjectStartableSchema.safeParse({
        ...minimal,
        mailboxId: "inbox-1",
        topicLanes: [{ id: "lane-1", tag: "Rücken", description: "Rückenschmerzen" }],
      }).success,
    ).toBe(true);
  });

  it("rejects invalid domains, slugs and quota combinations", () => {
    expect(
      LbProjectConfigSchema.safeParse({ ...minimal, allowedDomains: ["https://x.example"] })
        .success,
    ).toBe(false);
    expect(LbProjectConfigSchema.safeParse({ ...minimal, allowedDomains: [] }).success).toBe(false);
    expect(LbProjectConfigSchema.safeParse({ ...minimal, slug: "Demo Slug" }).success).toBe(false);
    expect(LbQuotasSchema.safeParse({ newPerDay: 1, livePerDay: 3, liveWeekCap: 2 }).success).toBe(
      false,
    );
    expect(
      LbQuotasSchema.safeParse({ newPerDay: 1, livePerDay: 1, maxLivePerHost: 2 }).success,
    ).toBe(false);
  });

  it("validates schedule windows, time zones and hard stop", () => {
    expect(LbScheduleSchema.safeParse({ timezone: "Mars/Olympus" }).success).toBe(false);
    expect(
      LbScheduleSchema.safeParse({
        timezone: "Europe/Vienna",
        window: { start: "22:00", end: "09:00" },
      }).success,
    ).toBe(false);
    expect(
      LbScheduleSchema.safeParse({
        timezone: "Europe/Zurich",
        window: { start: "09:00", end: "22:00" },
        hardStopHour: 21,
      }).success,
    ).toBe(false);
    expect(
      LbScheduleSchema.safeParse({
        timezone: "Europe/Zurich",
        window: { start: "9:00", end: "22:00" },
      }).success,
    ).toBe(false);
  });

  it("validates targets, link ratio and the why-not report", () => {
    expect(LbTargetSchema.safeParse({ url: "javascript:alert(1)" }).success).toBe(false);
    expect(LbTargetSchema.parse({ url: "https://demo-wellness.example/ruecken" }).priority).toBe(
      50,
    );
    expect(LbLinkRatioSchema.safeParse({ links: 4, posts: 3 }).success).toBe(false);
    expect(LbLinkRatioSchema.safeParse({ links: 1, posts: 0 }).success).toBe(false);
    expect(
      LbWhyNotSchema.safeParse({
        supply: { qualified: 0, ready: 0 },
        parked: 1,
        spamBlocked: 0,
        unsupportedCaptcha: 0,
        pendingEmail: 0,
        pendingAdmin: 0,
        modelErrors: 0,
        modelRefusals: 0,
        captchaBalance: null,
        proxy: "ok",
        reasons: ["host_supply_exhausted", "operator_parked"],
      }).success,
    ).toBe(true);
  });
});
