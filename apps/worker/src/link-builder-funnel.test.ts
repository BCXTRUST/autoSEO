import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterContext } from "@rakazo/adapter-kit";
import {
  RecordedSearchProvider,
  RecordedTextModel,
  recordedSerpDir,
  searchFixtureKey,
  textModelFixtureKey,
} from "@rakazo/adapters";
import type { LbDraftReply, LbTarget } from "@rakazo/contracts";
import {
  checkLanguage,
  countQualified,
  type DraftContext,
  discoverHosts,
  draftPrompt,
  draftWithModel,
  fitPrompt,
  footprintQuery,
  type ModelComplete,
  PROMPT_FORBIDDEN,
  platformFromUrl,
  relevancePrompt,
  reviewDraft,
  sampleForumHtml,
} from "@rakazo/linkbuilder-core";
import { describe, expect, it } from "vitest";

const context: AdapterContext = {
  operationId: "funnel",
  traceId: "funnel",
  workspaceId: "ws",
  userId: "user",
  signal: new AbortController().signal,
};

const de = {
  country: "DE" as const,
  language: "de" as const,
  locale: "de-DE",
  timezoneId: "Europe/Berlin",
};
const us = {
  country: "US" as const,
  language: "en" as const,
  locale: "en-US",
  timezoneId: "America/New_York",
};

describe("recorded discovery funnel", () => {
  it("qualifies at least 20 German hosts and tags the US market", async () => {
    const query = footprintQuery("Rückenschmerzen");
    expect(searchFixtureKey(query)).toBe("6823e88c37b60188");
    const root = recordedSerpDir();
    const search = new RecordedSearchProvider(root);
    const hits = await search.search({ query, country: "DE", language: "de", depth: 100 }, context);
    const htmlFor = new Map<string, string>();
    for (const hit of hits) {
      htmlFor.set(new URL(hit.url).hostname, htmlForHost(hit.url));
    }
    const usHits = await search.search(
      { query, country: "US", language: "en", depth: 100 },
      context,
    );
    for (const hit of usHits) htmlFor.set(new URL(hit.url).hostname, htmlForHost(hit.url));
    const hosts = await discoverHosts({
      lanes: [
        {
          id: "lane-ruecken",
          tag: "Rückenschmerzen",
          description: "Erfahrungen",
          exampleQuestions: [],
        },
      ],
      markets: [de, us],
      policy: "primary_first",
      supply: {},
      need: 1,
      denyHosts: ["rueckenforum.example"],
      usedHosts: ["schmerz-talk.example"],
      search: (request) => search.search(request, context),
      fetchText: async (url) => htmlFor.get(new URL(url).hostname) ?? null,
    });
    expect(countQualified(hosts, de)).toBeGreaterThanOrEqual(20);
    const american = hosts.find(
      (host) => host.market.country === "US" && host.status === "qualified",
    );
    expect(american?.market).toMatchObject({
      country: "US",
      language: "en",
      locale: "en-US",
      timezoneId: "America/New_York",
    });
    expect(hosts.some((host) => host.registrableDomain === "rueckenforum.example")).toBe(false);
    expect(hosts.some((host) => host.registrableDomain === "schmerz-talk.example")).toBe(false);
    expect(hosts.find((host) => host.registrableDomain === "arkose-board.example")?.status).toBe(
      "unsupported_captcha",
    );
    expect(hosts.find((host) => host.registrableDomain === "werbung-frei.example")?.status).toBe(
      "denied",
    );
    expect(hosts.filter((host) => host.registrableDomain === "fitness-board.example")).toHaveLength(
      1,
    );
  });
});

function htmlForHost(url: string): string {
  const host = new URL(url).hostname;
  if (host.startsWith("arkose-"))
    return sampleForumHtml({ platform: "phpbb", captcha: "funcaptcha" });
  if (host.startsWith("geetest-"))
    return sampleForumHtml({ platform: "xenforo", captcha: "geetest" });
  if (host.startsWith("keycaptcha-"))
    return sampleForumHtml({ platform: "vbulletin", captcha: "keycaptcha" });
  if (host.startsWith("werbung-"))
    return sampleForumHtml({ platform: "phpbb", commercialBan: true });
  const platform = platformFromUrl(url);
  if (platform === "unknown") return "<html><title>News</title><p>Artikel</p></html>";
  const parsed = new URL(url);
  return sampleForumHtml({ platform, threadPath: `${parsed.pathname}${parsed.search}` });
}

const target: LbTarget = {
  url: "https://nordlicht.example/ruecken",
  priority: 50,
  description: "Dehnen für den Rücken",
  keywordClusters: [],
};

function draftContext(overrides: Partial<DraftContext> = {}): DraftContext {
  return {
    displayName: "Mira Sol",
    bio: "Ich schreibe aus dem Verein.",
    register: "du",
    language: "de",
    country: "DE",
    toneNotes: "",
    facts: ["Kurze Pausen entlasten den Rücken."],
    targets: [target],
    allowedDomains: ["nordlicht.example"],
    title: "Was hilft bei Rückenschmerzen?",
    excerpt: "Nach dem Büro wird es steif.",
    laneTag: "Rückenschmerzen",
    laneDescription: "Erfahrungen",
    citeSource: true,
    disclosureMode: "undisclosed_persona",
    disclosureText: "Hinweis: gewerblich",
    content: { mode: "discard", bannedClaims: ["Wunderheilung"], maxReplyChars: 1200 },
    linkRatio: { links: 1, posts: 1 },
    postsOnHost: 0,
    linkPostsOnHost: 0,
    signatureLinks: false,
    allowEmoji: false,
    bodyFormat: "bbcode",
    ...overrides,
  };
}

const goodReply: LbDraftReply = {
  body: "Kurze Pausen entlasten den Rücken, und Dehnen danach ist oft genug. [REF]",
  linkSlot: "inline",
  targetUrlIndex: 0,
  anchorText: "Dehnen",
  confidence: 0.84,
};

async function harness(
  files: Array<{ lane: string; system: string; user: string; json: unknown }>,
): Promise<ModelComplete> {
  const root = await mkdtemp(join(tmpdir(), "lb-model-"));
  for (const file of files) {
    const dir = join(root, file.lane);
    await mkdir(dir, { recursive: true });
    const name = textModelFixtureKey(file.lane, file.system, file.user);
    await writeFile(join(dir, `${name}.json`), JSON.stringify(file.json));
  }
  const model = new RecordedTextModel(root);
  return ((request) => model.complete(request as never, context)) as ModelComplete;
}

function relevanceFile(
  ctx: DraftContext,
  json: unknown = {
    modelId: "recorded-classify",
    value: { relevance: 0.9, openQuestion: true, reasons: ["matches"] },
  },
) {
  const prompt = relevancePrompt({
    laneTag: ctx.laneTag,
    laneDescription: ctx.laneDescription,
    title: ctx.title,
    excerpt: ctx.excerpt,
    replies: [],
  });
  return { lane: "classify", ...prompt, json };
}

function draftFile(ctx: DraftContext, lane: "draft" | "fallback", json: unknown) {
  const prompt = draftPrompt({
    displayName: ctx.displayName,
    bio: ctx.bio,
    register: ctx.register,
    language: ctx.language,
    country: ctx.country,
    toneNotes: ctx.toneNotes,
    facts: ctx.facts,
    targets: ctx.targets,
    title: ctx.title,
    excerpt: ctx.excerpt,
    citeSource: ctx.citeSource,
    maxChars: ctx.content.maxReplyChars,
  });
  return { lane, ...prompt, json };
}

function fitFile(
  ctx: DraftContext,
  body: string,
  json: unknown,
  lane: "classify" | "fallback" = "classify",
) {
  const prompt = fitPrompt({ title: ctx.title, excerpt: ctx.excerpt, body, facts: ctx.facts });
  return { lane, ...prompt, json };
}

const fitOk = {
  modelId: "recorded-classify",
  value: { fitsThread: true, soundsLikeAd: false, factsOnly: true, issues: [] },
};

describe("recorded model harness", () => {
  it("keeps promotion language out of the prompts and drafts a source reply", async () => {
    const ctx = draftContext();
    const draft = draftPrompt({
      displayName: ctx.displayName,
      bio: ctx.bio,
      register: ctx.register,
      language: ctx.language,
      country: ctx.country,
      toneNotes: ctx.toneNotes,
      facts: ctx.facts,
      targets: ctx.targets,
      title: ctx.title,
      excerpt: ctx.excerpt,
      citeSource: true,
      maxChars: ctx.content.maxReplyChars,
    });
    expect(`${draft.system}\n${draft.user}`).not.toMatch(PROMPT_FORBIDDEN);
    const prepared = await draftWithModel(
      await harness([
        relevanceFile(ctx),
        draftFile(ctx, "draft", { modelId: "recorded-draft", value: goodReply }),
        fitFile(ctx, goodReply.body, fitOk),
      ]),
      ctx,
    );
    expect(prepared.action).toBe("post");
    expect(prepared.body).toContain("[url=https://nordlicht.example/ruecken]");
    expect(prepared.body).not.toContain("Hinweis: gewerblich");
    expect(prepared.linkSlot).toBe("inline");
    expect(prepared.anchorText).toBe("Dehnen");
  });

  it("retries a refusal and an off-schema answer on the fallback lane", async () => {
    const ctx = draftContext();
    const refused = await draftWithModel(
      await harness([
        relevanceFile(ctx),
        draftFile(ctx, "draft", {
          modelId: "recorded-draft",
          ok: false,
          reason: "refusal",
          raw: "Ich kann dir dabei leider nicht helfen.",
        }),
        draftFile(ctx, "fallback", { modelId: "recorded-fallback", value: goodReply }),
        fitFile(ctx, goodReply.body, fitOk),
      ]),
      ctx,
    );
    expect(refused.action).toBe("post");
    expect(refused.modelLane).toBe("fallback");
    expect(refused.modelRefusal).toBe(true);

    const offSchema = await draftWithModel(
      await harness([
        relevanceFile(ctx),
        draftFile(ctx, "draft", { modelId: "recorded-draft", value: { nope: true } }),
        draftFile(ctx, "fallback", { modelId: "recorded-fallback", value: goodReply }),
        fitFile(ctx, goodReply.body, fitOk),
      ]),
      ctx,
    );
    expect(offSchema.modelLane).toBe("fallback");
    expect(offSchema.action).toBe("post");
  });

  it("retries when the fit check says the reply sounds like an ad", async () => {
    const ctx = draftContext();
    const ad = { ...goodReply, body: "Kauft sofort dieses Angebot. [REF]" };
    const prepared = await draftWithModel(
      await harness([
        relevanceFile(ctx),
        draftFile(ctx, "draft", { modelId: "recorded-draft", value: ad }),
        fitFile(ctx, ad.body, {
          modelId: "recorded-classify",
          value: { fitsThread: true, soundsLikeAd: true, factsOnly: true, issues: ["ad"] },
        }),
        draftFile(ctx, "fallback", { modelId: "recorded-fallback", value: goodReply }),
        fitFile(ctx, goodReply.body, fitOk),
      ]),
      ctx,
    );
    expect(prepared.action).toBe("post");
    expect(prepared.modelId).toBe("recorded-fallback");
    expect(prepared.body).not.toContain("Kauft sofort");
  });

  it("discards or queues a draft that is not facts-only", async () => {
    const ctx = draftContext();
    const fit = {
      modelId: "recorded-classify",
      value: { fitsThread: true, soundsLikeAd: false, factsOnly: false, issues: ["extra claim"] },
    };
    const discarded = await draftWithModel(
      await harness([
        relevanceFile(ctx),
        draftFile(ctx, "draft", { modelId: "recorded-draft", value: goodReply }),
        fitFile(ctx, goodReply.body, fit),
      ]),
      ctx,
    );
    expect(discarded.action).toBe("discard");
    const queued = await draftWithModel(
      await harness([
        relevanceFile(ctx),
        draftFile(ctx, "draft", { modelId: "recorded-draft", value: goodReply }),
        fitFile(ctx, goodReply.body, fit),
      ]),
      draftContext({ content: { mode: "queue", bannedClaims: [], maxReplyChars: 1200 } }),
    );
    expect(queued.action).toBe("queue");
  });

  it("posts a warm-up reply that is not limited to the fact sheet", async () => {
    const ctx = draftContext({ citeSource: false });
    const reply = {
      ...goodReply,
      linkSlot: "none" as const,
      targetUrlIndex: null,
      anchorText: null,
      body: "Bei mir hat Dehnen nach der Arbeit geholfen.",
    };
    const prepared = await draftWithModel(
      await harness([
        relevanceFile(ctx),
        draftFile(ctx, "draft", { modelId: "recorded-draft", value: reply }),
        fitFile(ctx, reply.body, {
          modelId: "recorded-classify",
          value: { fitsThread: true, soundsLikeAd: false, factsOnly: false, issues: ["extra"] },
        }),
      ]),
      ctx,
    );
    expect(prepared.action).toBe("post");
    expect(prepared.linkSlot).toBe("none");
    expect(prepared.body).toContain("Dehnen");
  });

  it("rejects a banned claim, Swiss sharp s, a long anchor and a foreign target", () => {
    const banned = reviewDraft({
      reply: { ...goodReply, body: "Das ist garantiert schmerzfrei. [REF]" },
      fit: { fitsThread: true, soundsLikeAd: false, factsOnly: true, issues: [] },
      context: draftContext(),
      modelLane: "draft",
      modelId: "recorded-draft",
      tokens: 1,
      modelRefusal: false,
    });
    expect(banned.action).toBe("discard");
    expect(banned.qualityChecks.noBannedClaims).toBe(false);

    const swiss = checkLanguage({
      body: "Grüezi, das ist groß.",
      register: "du",
      language: "de",
      country: "CH",
      maxChars: 1200,
      allowEmoji: false,
    });
    expect(swiss.issues).toContain("swiss_orthography");

    const anchor = reviewDraft({
      reply: { ...goodReply, anchorText: "x".repeat(61) },
      fit: { fitsThread: true, soundsLikeAd: false, factsOnly: true, issues: [] },
      context: draftContext(),
      modelLane: "draft",
      modelId: "recorded-draft",
      tokens: 1,
      modelRefusal: false,
    });
    expect(anchor.action).toBe("discard");
    expect(anchor.qualityChecks.issues.some((issue) => issue.startsWith("anchor"))).toBe(true);

    const foreign = reviewDraft({
      reply: goodReply,
      fit: { fitsThread: true, soundsLikeAd: false, factsOnly: true, issues: [] },
      context: draftContext({ allowedDomains: ["other.example"] }),
      modelLane: "draft",
      modelId: "recorded-draft",
      tokens: 1,
      modelRefusal: false,
    });
    expect(foreign.action).toBe("discard");
    expect(foreign.qualityChecks.issues).toContain("target");
  });
});
