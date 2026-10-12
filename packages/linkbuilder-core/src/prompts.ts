import type { LbRegister, LbTarget } from "@rakazo/contracts";

/*
 * Prompts for the three structured jobs. They ask the model to answer as a person and to mark
 * a source with [REF]. They never mention promotion, SEO, link building or non-disclosure.
 */

export interface PromptPair {
  system: string;
  user: string;
}

const SYSTEM = [
  "You answer a forum thread as the person described below.",
  "Use only the facts you are given and what the thread already says.",
  "Write in that person's language and form of address.",
  "When one of the listed sources would help the reader, put the marker [REF] once where it fits.",
  "If none of the sources fits, leave the marker out.",
  "Reply with JSON only.",
].join(" ");

export function relevancePrompt(input: {
  laneTag: string;
  laneDescription: string;
  title: string;
  excerpt: string;
  replies: readonly string[];
}): PromptPair {
  const replies = input.replies
    .slice(-3)
    .map((reply, index) => `Reply ${index + 1}: ${reply}`)
    .join("\n");
  return {
    system:
      'You compare a forum thread with a topic. Score relevance from 0 to 1. openQuestion is true when the author is still asking for an answer. Reply with JSON only: {"relevance": number, "openQuestion": boolean, "reasons": string[]}.',
    user: [
      `Topic: ${input.laneTag}`,
      input.laneDescription,
      `Title: ${input.title}`,
      `First post: ${input.excerpt}`,
      replies,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export function draftPrompt(input: {
  displayName: string;
  bio: string;
  register: LbRegister;
  language: string;
  country: string;
  toneNotes: string;
  facts: readonly string[];
  targets: readonly Pick<LbTarget, "url" | "description">[];
  title: string;
  excerpt: string;
  /** Warm-up replies must not cite a source. */
  citeSource: boolean;
  maxChars: number;
}): PromptPair {
  const address =
    input.language.split("-")[0] === "de"
      ? input.register === "sie"
        ? "Address the reader with Sie."
        : "Address the reader with du."
      : "Write in a friendly, plain register.";
  const spelling =
    input.country === "CH"
      ? "Use Swiss spelling: write ss and never the sharp s."
      : input.country === "DE" || input.country === "AT"
        ? "Use the spelling of that country."
        : "";
  const sources = input.targets
    .map((target, index) => `${index}. ${target.description || target.url}`)
    .join("\n");
  const facts = input.facts.map((fact) => `- ${fact}`).join("\n");
  const cite = input.citeSource
    ? "You may mark one source with [REF]. Set linkSlot to inline when [REF] is in the body, signature when the source belongs under the post, or none when you did not use a source. Set targetUrlIndex to that source's index, or null. anchorText is a short phrase of at most 60 characters, or null."
    : "Do not cite a source. Do not use [REF]. Do not mention a shop, a brand, or something to buy. Set linkSlot to none, targetUrlIndex to null and anchorText to null.";
  return {
    system: SYSTEM,
    user: [
      `You are ${input.displayName}.`,
      input.bio,
      `Language: ${input.language}.`,
      address,
      spelling,
      input.toneNotes,
      "Facts you may state:",
      facts || "(none)",
      "Sources you may cite:",
      sources || "(none)",
      cite,
      `Write at most ${input.maxChars} characters.`,
      "Do not state a number or a percentage unless it is in the facts or the thread.",
      'Reply with JSON only, with these keys: "body" (the forum reply), "linkSlot" ("none", "inline", or "signature"), "targetUrlIndex" (a number or null), "anchorText" (a short string or null), "confidence" (a number from 0 to 1).',
      `Thread title: ${input.title}`,
      `Thread: ${input.excerpt}`,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export function fitPrompt(input: {
  title: string;
  excerpt: string;
  body: string;
  facts: readonly string[];
}): PromptPair {
  return {
    system:
      "You compare a reply with the thread it answers. fitsThread is true when the reply answers the thread. soundsLikeAd is true when the reply reads like an advertisement. factsOnly is true when every claim is supported by the facts or the thread. List problems in issues. Reply with JSON only.",
    user: [
      `Title: ${input.title}`,
      `Thread: ${input.excerpt}`,
      "Facts:",
      input.facts.map((fact) => `- ${fact}`).join("\n") || "(none)",
      "Reply:",
      input.body,
    ].join("\n"),
  };
}

/** Phrases the prompts must not contain. Checked by the harness. */
export const PROMPT_FORBIDDEN =
  /promot|seo|link building|link-building|non-disclosure|undisclosed/i;
