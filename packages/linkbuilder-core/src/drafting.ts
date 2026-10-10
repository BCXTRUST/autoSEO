import {
  type LbContent,
  type LbDisclosureMode,
  type LbDraftQualityChecks,
  type LbDraftReply,
  LbDraftReplySchema,
  type LbFitCheck,
  LbFitCheckSchema,
  type LbLanguage,
  type LbLinkRatio,
  type LbLinkSlot,
  type LbModelLane,
  type LbRegister,
  type LbTarget,
  type LbThreadRelevance,
  LbThreadRelevanceSchema,
} from "@rakazo/contracts";
import {
  containsBannedClaim,
  enforceSingleLink,
  exceedsLinkRatio,
  insertReference,
  looksLikeTestimonial,
  MAX_ANCHOR_CHARS,
  type ReferenceFormat,
  refusalDetector,
  validateAnchor,
  validateTargetUrl,
} from "./policy.js";
import { draftPrompt, fitPrompt, relevancePrompt } from "./prompts.js";

const CONFIDENCE_FLOOR = 0.3;

/** Gemini reasoning tokens count against this budget, so the JSON reply needs room past the thinking. */
export const DRAFT_MAX_TOKENS = 4_000;
export const CLASSIFY_MAX_TOKENS = 2_000;

export interface ModelTokens {
  input: number;
  output: number;
}

export type ModelResult<T> =
  | { ok: true; value: T; modelId: string; tokens: ModelTokens }
  | { ok: false; reason: "refusal" | "schema" | "error"; raw?: string; modelId: string };

export interface ModelRequest<T> {
  lane: LbModelLane;
  system: string;
  user: string;
  schema: { safeParse(value: unknown): { success: boolean; data?: T } };
  maxTokens: number;
}

export type ModelComplete = <T>(request: ModelRequest<T>) => Promise<ModelResult<T>>;

export interface DraftContext {
  displayName: string;
  bio: string;
  register: LbRegister;
  language: LbLanguage;
  country: string;
  toneNotes: string;
  facts: readonly string[];
  targets: readonly LbTarget[];
  allowedDomains: readonly string[];
  title: string;
  excerpt: string;
  replies?: readonly string[];
  laneTag: string;
  laneDescription: string;
  citeSource: boolean;
  disclosureMode: LbDisclosureMode;
  disclosureText?: string;
  content: Pick<LbContent, "mode" | "bannedClaims" | "maxReplyChars">;
  linkRatio: LbLinkRatio;
  postsOnHost: number;
  linkPostsOnHost: number;
  signatureLinks: boolean;
  allowEmoji: boolean;
  bodyFormat: ReferenceFormat;
}

export type DraftAction = "post" | "queue" | "discard" | "refused";

export interface PreparedDraft {
  action: DraftAction;
  body: string;
  linkSlot: LbLinkSlot;
  targetUrl: string | null;
  anchorText: string | null;
  modelLane: LbModelLane;
  modelId: string;
  confidence: number | null;
  qualityChecks: LbDraftQualityChecks;
  /** True when a lane refused, failed the schema, or came back under the confidence floor. */
  modelRefusal: boolean;
  tokens: number;
  relevance: LbThreadRelevance | null;
}

export interface ThreadSelection {
  selected: boolean;
  rejectReason?: string;
}

/**
 * Plan 6.4 step 1. The date that matters is the newest post already in the thread.
 * A thread opened in 2007 is fine when someone replied this week. A thread whose last
 * reply is older than the activity window is finished: a new reply will not get an answer.
 * No visible date is the same as too old. A missing timestamp used to count as fresh,
 * which is how a reply landed under a post from October 2024.
 */
export function selectThreadCandidate(input: {
  relevance: number;
  openQuestion: boolean;
  lastActivityAt: Date | null;
  now: Date;
  activityDays: number;
  pageText: string;
  allowedDomains: readonly string[];
  laneId: string | null;
  excludedLaneIds: readonly string[];
}): ThreadSelection {
  if (input.relevance < 0.7) return { selected: false, rejectReason: "low_relevance" };
  if (!input.openQuestion) return { selected: false, rejectReason: "not_open" };
  if (input.laneId && input.excludedLaneIds.includes(input.laneId)) {
    return { selected: false, rejectReason: "lane_excluded" };
  }
  if (!input.lastActivityAt) return { selected: false, rejectReason: "inactive" };
  const ageDays = (input.now.getTime() - input.lastActivityAt.getTime()) / 86_400_000;
  if (ageDays > input.activityDays) return { selected: false, rejectReason: "inactive" };
  if (mentionsAllowedDomain(input.pageText, input.allowedDomains)) {
    return { selected: false, rejectReason: "already_linked" };
  }
  return { selected: true };
}

export function mentionsAllowedDomain(text: string, allowedDomains: readonly string[]): boolean {
  const haystack = text.toLowerCase();
  return allowedDomains.some((domain) => haystack.includes(domain.toLowerCase()));
}

export interface LanguageIssues {
  ok: boolean;
  issues: string[];
}

/** Keeps a reply inside the board limit, on a sentence boundary when one fits. */
export function trimReply(body: string, maxChars: number): string {
  const chars = [...body.trim()];
  if (chars.length <= maxChars) return chars.join("");
  const cut = chars.slice(0, maxChars).join("").trimEnd();
  const sentence = /^[\s\S]*[.!?](?=\s|$)/.exec(cut)?.[0]?.trim() ?? "";
  if ([...sentence].length >= 20) return sentence;
  return cut;
}

/** Register, Swiss orthography, length and the driver's emoji flag. */
export function checkLanguage(input: {
  body: string;
  register: LbRegister;
  language: string;
  country: string;
  maxChars: number;
  allowEmoji: boolean;
}): LanguageIssues {
  const issues: string[] = [];
  const length = [...input.body].length;
  if (length < 20 || length > input.maxChars) issues.push("length");
  if (!input.allowEmoji && /\p{Extended_Pictographic}/u.test(input.body)) issues.push("emoji");
  if (input.country === "CH" && input.body.includes("ß")) issues.push("swiss_orthography");
  if ((input.language.split("-")[0] ?? "") === "de") {
    if (
      input.register === "du" &&
      /(?<![\p{L}])(Sie|Ihnen|Ihre|Ihrem|Ihren|Ihrer)(?![\p{L}])/u.test(input.body)
    ) {
      issues.push("register");
    }
    if (
      input.register === "sie" &&
      /(?<![\p{L}\p{N}])(du|dich|dir|dein|deine|deinen|deinem|deiner|euch|euer|eure)(?![\p{L}\p{N}])/iu.test(
        input.body,
      )
    ) {
      issues.push("register");
    }
  }
  return { ok: issues.length === 0, issues };
}

export function reviewDraft(input: {
  reply: LbDraftReply;
  fit: LbFitCheck;
  context: DraftContext;
  modelLane: LbModelLane;
  modelId: string;
  tokens: number;
  modelRefusal: boolean;
}): PreparedDraft {
  const issues = [...input.fit.issues];
  let slot: LbLinkSlot = input.context.citeSource ? input.reply.linkSlot : "none";
  let targetUrl: string | null = null;
  let anchorText: string | null = null;
  let body = input.reply.body;

  if (slot !== "none") {
    const index = input.reply.targetUrlIndex;
    const target = index === null ? undefined : input.context.targets[index];
    const check = target ? validateTargetUrl(target.url, input.context.allowedDomains) : null;
    const listed = target ? input.context.targets.some((item) => item.url === target.url) : false;
    if (!target || !check?.ok || !listed) {
      issues.push("target");
      slot = "none";
    } else {
      targetUrl = check.url;
      const anchor = validateAnchor(input.reply.anchorText ?? "");
      if (!anchor.ok || [...anchor.text].length > MAX_ANCHOR_CHARS) {
        issues.push(anchor.ok ? "anchor" : `anchor_${anchor.reason}`);
        slot = "none";
        targetUrl = null;
      } else {
        anchorText = anchor.text;
      }
    }
  }

  if (
    slot !== "none" &&
    exceedsLinkRatio({
      postsOnHost: input.context.postsOnHost,
      linkPostsOnHost: input.context.linkPostsOnHost,
      ratio: input.context.linkRatio,
    })
  ) {
    issues.push("link_ratio");
    slot = "none";
    targetUrl = null;
    anchorText = null;
  }
  if (slot === "signature" && !input.context.signatureLinks) slot = "inline";

  if (slot === "none" || !targetUrl || !anchorText) {
    body = enforceSingleLink(body, { stripAll: true }).body.replace(/[ \t]*\[REF\]/g, "");
    slot = "none";
    targetUrl = null;
    anchorText = null;
  } else if (slot === "signature") {
    body = enforceSingleLink(body.replace(/[ \t]*\[REF\]/g, ""), { stripAll: true }).body;
  } else {
    body = insertReference(body, {
      targetUrl,
      anchorText,
      slot: "inline",
      format: input.context.bodyFormat,
      language: input.context.language,
      register: input.context.register,
    });
    body = enforceSingleLink(body, { keepUrl: targetUrl }).body;
  }

  const mode = input.context.disclosureMode;
  const disclosure = input.context.disclosureText?.trim() ?? "";
  if ((mode === "disclosed_persona" || mode === "disclosed_brand") && disclosure) {
    if (!body.includes(disclosure)) body = `${body}\n\n${disclosure}`;
  }

  body = trimReply(body, input.context.content.maxReplyChars);
  const banned = containsBannedClaim(body, input.context.content.bannedClaims);
  const testimonial = testimonialUnsupported(body, input.context.facts);
  const language = checkLanguage({
    body,
    register: input.context.register,
    language: input.context.language,
    country: input.context.country,
    maxChars: input.context.content.maxReplyChars,
    allowEmoji: input.context.allowEmoji,
  });
  const linkCount = enforceSingleLink(body).linkCount;
  if (banned.banned) issues.push("banned_claim");
  if (testimonial) issues.push("testimonial");
  issues.push(...language.issues);
  if (slot !== "none" && linkCount !== 1) issues.push("link_count");
  if (slot === "none" && linkCount !== 0) issues.push("link_count");
  if (!input.fit.fitsThread) issues.push("fits_thread");
  if (input.fit.soundsLikeAd) issues.push("sounds_like_ad");
  if (!input.fit.factsOnly) issues.push("facts_only");

  const qualityChecks: LbDraftQualityChecks = {
    factsOnly: input.fit.factsOnly && !issues.includes("facts_only"),
    noBannedClaims: !banned.banned,
    registerMatches: !language.issues.includes("register"),
    lengthOk: !language.issues.includes("length"),
    singleLink: !issues.includes("link_count"),
    notTestimonial: !testimonial,
    issues: [...new Set(issues)],
  };

  const hard = qualityChecks.issues.some(
    (issue) =>
      issue === "banned_claim" ||
      issue === "testimonial" ||
      issue === "length" ||
      issue === "emoji" ||
      issue === "swiss_orthography" ||
      issue === "register" ||
      issue === "link_count" ||
      issue === "target" ||
      issue === "fits_thread" ||
      issue === "sounds_like_ad" ||
      issue.startsWith("anchor"),
  );
  let action: DraftAction = "post";
  // A warm-up reply cites nothing, so it is not limited to the source fact sheet.
  if (!input.fit.factsOnly && input.context.citeSource) {
    action = input.context.content.mode === "queue" ? "queue" : "discard";
  }
  if (hard) action = "discard";
  if (input.fit.soundsLikeAd) action = "discard";

  return {
    action,
    body: body.trim(),
    linkSlot: slot,
    targetUrl,
    anchorText,
    modelLane: input.modelLane,
    modelId: input.modelId,
    confidence: input.reply.confidence,
    qualityChecks,
    modelRefusal: input.modelRefusal,
    tokens: input.tokens,
    relevance: null,
  };
}

function testimonialUnsupported(body: string, facts: readonly string[]): boolean {
  if (!looksLikeTestimonial(body)) return false;
  return !facts.some((fact) => looksLikeTestimonial(fact) && body.includes(fact.trim()));
}

function refusedText(result: ModelResult<unknown>): boolean {
  if (!result.ok) {
    if (result.reason === "refusal" || result.reason === "schema") return true;
    return result.raw ? refusalDetector(result.raw).refused : result.reason === "error";
  }
  return false;
}

/**
 * Draft lane, then one retry on the fallback lane when the draft is refused, off-schema,
 * low-confidence, or flagged soundsLikeAd. A failed facts-only check is not a retry.
 */
export async function draftWithModel(
  complete: ModelComplete,
  context: DraftContext,
): Promise<PreparedDraft> {
  const relevanceMessages = relevancePrompt({
    laneTag: context.laneTag,
    laneDescription: context.laneDescription,
    title: context.title,
    excerpt: context.excerpt,
    replies: context.replies ?? [],
  });
  const relevance = await complete({
    lane: "classify",
    ...relevanceMessages,
    schema: LbThreadRelevanceSchema,
    maxTokens: CLASSIFY_MAX_TOKENS,
  });
  let lane: LbModelLane = "draft";
  let modelRefusal = false;
  let tokens = relevance.ok ? relevance.tokens.input + relevance.tokens.output : 0;
  let last: PreparedDraft | null = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const messages = draftPrompt({
      displayName: context.displayName,
      bio: context.bio,
      register: context.register,
      language: context.language,
      country: context.country,
      toneNotes: context.toneNotes,
      facts: context.facts,
      targets: context.targets,
      title: context.title,
      excerpt: context.excerpt,
      citeSource: context.citeSource,
      maxChars: context.content.maxReplyChars,
    });
    const drafted = await complete({
      lane,
      ...messages,
      schema: LbDraftReplySchema,
      maxTokens: DRAFT_MAX_TOKENS,
    });
    tokens += drafted.ok ? drafted.tokens.input + drafted.tokens.output : 0;
    const bodyRefusal =
      drafted.ok &&
      (refusalDetector(drafted.value.body).refused || drafted.value.confidence < CONFIDENCE_FLOOR);
    if (!drafted.ok || bodyRefusal || refusedText(drafted)) {
      modelRefusal = true;
      if (lane === "draft") {
        lane = "fallback";
        continue;
      }
      return emptyRefusal(drafted.ok ? drafted.modelId : drafted.modelId, tokens);
    }

    const fitMessages = fitPrompt({
      title: context.title,
      excerpt: context.excerpt,
      body: drafted.value.body,
      facts: context.facts,
    });
    let fit = await complete({
      lane: "classify",
      ...fitMessages,
      schema: LbFitCheckSchema,
      maxTokens: CLASSIFY_MAX_TOKENS,
    });
    if (!fit.ok) {
      fit = await complete({
        lane: "fallback",
        ...fitMessages,
        schema: LbFitCheckSchema,
        maxTokens: CLASSIFY_MAX_TOKENS,
      });
    }
    tokens += fit.ok ? fit.tokens.input + fit.tokens.output : 0;
    if (!fit.ok) {
      modelRefusal = true;
      if (lane === "draft") {
        lane = "fallback";
        continue;
      }
      return emptyRefusal(fit.modelId, tokens);
    }
    if (fit.value.soundsLikeAd && lane === "draft") {
      lane = "fallback";
      continue;
    }
    last = reviewDraft({
      reply: drafted.value,
      fit: fit.value,
      context,
      modelLane: lane,
      modelId: drafted.modelId,
      tokens,
      modelRefusal,
    });
    last.relevance = relevance.ok ? relevance.value : null;
    return last;
  }
  return last ?? emptyRefusal("none", tokens);
}

function emptyRefusal(modelId: string, tokens: number): PreparedDraft {
  return {
    action: "refused",
    body: "",
    linkSlot: "none",
    targetUrl: null,
    anchorText: null,
    modelLane: "fallback",
    modelId,
    confidence: null,
    qualityChecks: {
      factsOnly: false,
      noBannedClaims: true,
      registerMatches: true,
      lengthOk: false,
      singleLink: true,
      notTestimonial: true,
      issues: ["model_refusal"],
    },
    modelRefusal: true,
    tokens,
    relevance: null,
  };
}

export function emptyQuality(issues: string[] = []): LbDraftQualityChecks {
  return {
    factsOnly: true,
    noBannedClaims: true,
    registerMatches: true,
    lengthOk: true,
    singleLink: true,
    notTestimonial: true,
    issues,
  };
}
