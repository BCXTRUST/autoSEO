import { shopNames, stripShopNames } from "./problem-queries.js";

/**
 * A forum is sign-up eligible when its page, title, or topic tags share a lane or keyword
 * with the project. The shop name is not a topic. Cars, operating systems, office software,
 * and unrelated hobbies are not eligible even when the body mentions a lane word in passing.
 */

export interface TopicProject {
  name?: string | null;
  brandName?: string | null;
  topicLanes?: unknown;
  targets?: unknown;
}

export interface TopicPage {
  pageText?: string | null;
  title?: string | null;
  topicTags?: readonly string[] | null;
}

const STOP = new Set([
  "sells",
  "relevant",
  "forum",
  "real",
  "human",
  "problem",
  "those",
  "products",
  "touch",
  "search",
  "german",
  "brand",
  "landing",
  "page",
  "link",
  "placed",
  "later",
  "only",
  "kaufen",
  "bestellen",
  "shop",
  "tipps",
  "tagesbedarf",
  "dosierungen",
  "formel",
  "vitaminexpress",
]);

/** German readings of the problem words stored on the lanes. */
const FOLDS: Record<string, readonly string[]> = {
  sleep: ["schlaf", "schlafen", "einschlafen"],
  pain: ["schmerz", "schmerzen"],
  cramps: ["krampf", "krämpfe"],
  sport: ["sport", "training", "fitness"],
  training: ["training", "fitness"],
  children: ["kind", "kinder", "familie", "familien"],
  mood: ["stimmung"],
  pregnancy: ["schwanger", "schwangerschaft"],
  deficiency: ["mangel"],
  energy: ["energie"],
  supplements: ["supplement", "nahrungsergänzung"],
  family: ["familie", "familien", "kinder"],
  health: ["gesundheit"],
};

const TITLE_OFF_TOPIC = [
  "bmw",
  "tuning",
  "fahrzeug",
  "motorrad",
  "automobil",
  "windows",
  "linux",
  "microsoft",
  "macos",
  "betriebssystem",
  "excel",
  "outlook",
  "powerpoint",
  "office",
  "pickup",
  "flirt",
  "verfuehrung",
] as const;

function foldText(value: string): string {
  return value.replace(/ß/g, "ss").toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
}

function tokensOf(value: string): string[] {
  return foldText(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 || token === "b12" || token === "k2");
}

function pushText(chunks: string[], value: unknown): void {
  if (typeof value === "string" && value.trim()) chunks.push(value);
}

function laneChunks(project: TopicProject): string[] {
  const chunks: string[] = [];
  if (Array.isArray(project.topicLanes)) {
    for (const lane of project.topicLanes) {
      if (!lane || typeof lane !== "object") continue;
      const record = lane as {
        tag?: unknown;
        description?: unknown;
        exampleQuestions?: unknown;
      };
      pushText(chunks, record.tag);
      pushText(chunks, record.description);
      if (Array.isArray(record.exampleQuestions)) {
        for (const question of record.exampleQuestions) pushText(chunks, question);
      }
    }
  }
  if (Array.isArray(project.targets)) {
    for (const target of project.targets) {
      if (!target || typeof target !== "object") continue;
      const record = target as { description?: unknown; keywordClusters?: unknown };
      pushText(chunks, record.description);
      if (Array.isArray(record.keywordClusters)) {
        for (const cluster of record.keywordClusters) pushText(chunks, cluster);
      }
    }
  }
  return chunks;
}

/** Lane tags, descriptions, questions, and keyword clusters, without the shop name. */
export function topicTerms(project: TopicProject): string[] {
  const cleaned = stripShopNames(laneChunks(project).join("\n"), shopNames(project));
  const terms = new Set<string>();
  for (const token of tokensOf(cleaned)) {
    if (STOP.has(token)) continue;
    terms.add(foldText(token));
    for (const folded of FOLDS[token] ?? []) terms.add(foldText(folded));
  }
  return [...terms];
}

function hasWord(text: string, word: string): boolean {
  const hay = foldText(text);
  const needle = foldText(word);
  if (needle.length < 3) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`).test(hay);
}

export function hasTerm(text: string, term: string): boolean {
  if (hasWord(text, term)) return true;
  if (term.length < 6) return false;
  const hay = foldText(text);
  const needle = foldText(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${needle}`).test(hay);
}

function titleIsOffTopic(title: string, terms: readonly string[]): boolean {
  if (!title.trim()) return false;
  if (terms.some((term) => hasTerm(title, term))) return false;
  return TITLE_OFF_TOPIC.some((word) => hasWord(title, word));
}

/** True when the page shares a project topic. No lanes means the gate stays open. */
export function pageMatchesTopics(page: TopicPage, project: TopicProject): boolean {
  const terms = topicTerms(project);
  if (terms.length === 0) return true;
  const title = page.title ?? "";
  if (titleIsOffTopic(title, terms)) return false;
  const blob = [page.pageText ?? "", title].join("\n");
  return terms.some((term) => hasTerm(blob, term));
}

/**
 * Patient threads on a health board often never say the lane word.
 * The title has to name a condition, a symptom, or a treatment.
 * Chat titles stay off-topic even when a reply mentions a doctor.
 */
/** German problem words for the lane themes. Harold may edit this list. */
const WARMUP_HEALTH_TERMS = [
  "müdigkeit",
  "müde",
  "erschöpfung",
  "schlafstörung",
  "verdauung",
  "darm",
  "verstopfung",
  "durchfall",
  "schilddrüse",
  "hashimoto",
  "immunsystem",
  "erkältung",
  "haut",
  "haare",
  "nägel",
  "gelenke",
  "knochen",
  "muskel",
  "muskelkater",
  "regeneration",
  "blutwerte",
  "eisen",
  "ferritin",
  "vitamin d",
  "b12",
  "magnesium",
  "zink",
  "selen",
  "jod",
  "omega",
  "ernährung",
  "nährstoff",
  "stoffwechsel",
  "blutzucker",
  "diabetes",
  "metformin",
  "schwangerschaft",
  "stillen",
  "kinderwunsch",
  "wechseljahre",
  "migräne",
  "kopfschmerzen",
  "wadenkrämpfe",
  "stress",
  "stimmung",
  "depression",
] as const;

export function warmupHealthTitle(title: string): boolean {
  return WARMUP_HEALTH_TERMS.some((term) => hasTerm(title, term));
}

/** Link posts need a lane word in the title or the opening post, not only on the last page. */
export function laneTermInTitleOrOpener(
  title: string,
  opener: string,
  project: TopicProject,
): boolean {
  const terms = topicTerms(project);
  if (terms.length === 0) return true;
  return terms.some((term) => hasTerm(title, term) || hasTerm(opener, term));
}

/** Title or board section that is an introduction, a game, or off-topic chat. */
export const WARMUP_TITLE_BLOCK =
  /hallo|vorstell|neu hier|willkommen|stelle mich|\babc\b|a-z|a bis z|kette|wörter|this or that|filme|\bserie|\bmusik|hört ihr|kocht ihr|\bnews\b|\bwahl(en)?\b|plauder|café|cafe|off.?topic|laber|\bspiel\w*|witz|geburtstag/i;

/** Board names that are worth opening, besides a direct health-term hit. */
export const WARMUP_BOARD_TERMS = [
  "medizin",
  "orthopädie",
  "innere",
  "ernährung",
  "fitness",
  "immun",
  "wechseljahre",
  "kinderwunsch",
  "schwanger",
  "stoffwechsel",
  "magen",
  "darm",
  "kopfschmerz",
  "haut",
  "wohlbefinden",
  "alternativ",
] as const;

const BOARD_DROP =
  /caf[eé]|plauder|spiel|vorstell|rund ums forum|tier|beziehung|sexualit|beruf|abschied|trauer|gesundheitswesen|sucht|krebs|pflege|behinderung|psycholog|ängste/i;

/** Higher is a better board to open. Dropped boards score -1. */
export function warmupBoardScore(name: string, terms: readonly string[] = []): number {
  const title = name.replace(/\s+/g, " ").trim();
  if (!title || BOARD_DROP.test(title)) return -1;
  let score = 0;
  if (WARMUP_HEALTH_TERMS.some((term) => hasTerm(title, term))) score += 2;
  if (terms.some((term) => hasTerm(title, term))) score += 2;
  if (WARMUP_BOARD_TERMS.some((term) => hasTerm(title, term))) score += 1;
  return score;
}

export interface WarmupPost {
  author: string;
  at: string | null;
}

export interface WarmupThreadMeta {
  lastActivityAt: string | null;
  posts: WarmupPost[];
  closed: boolean;
  section: string | null;
}

export type WarmupRejectReason =
  | "intro_or_game"
  | "off_topic_thread"
  | "stale"
  | "no_other_users"
  | "own_last"
  | "closed";

const DAY_MS = 86_400_000;

function namesMatch(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function ageDays(at: string, now: Date): number | null {
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed)) return null;
  return (now.getTime() - parsed) / DAY_MS;
}

/**
 * A warmup reply needs an active on-topic thread that someone else posted in recently.
 * Tags on the host do not count as topic text.
 */
export function warmupThreadEligible(input: {
  title: string;
  section?: string | null;
  firstPost?: string | null;
  meta: WarmupThreadMeta;
  username: string;
  now: Date;
  project: TopicProject;
  activityDays?: number;
}): { ok: true } | { ok: false; reason: WarmupRejectReason } {
  const section = input.section ?? input.meta.section;
  if (WARMUP_TITLE_BLOCK.test(`${input.title}\n${section ?? ""}`)) {
    return { ok: false, reason: "intro_or_game" };
  }
  const terms = topicTerms(input.project);
  if (terms.length > 0) {
    const first = (input.firstPost ?? "").slice(0, 1_500);
    const onTopic =
      warmupHealthTitle(input.title) ||
      warmupHealthTitle(first) ||
      terms.some((term) => hasTerm(input.title, term) || hasTerm(first, term));
    if (!onTopic) return { ok: false, reason: "off_topic_thread" };
  }
  const windowDays = input.activityDays ?? 30;
  const lastAge = input.meta.lastActivityAt ? ageDays(input.meta.lastActivityAt, input.now) : null;
  if (lastAge === null || lastAge > windowDays) return { ok: false, reason: "stale" };
  const foreignDays = Math.min(windowDays, 21);
  const foreignRecent = input.meta.posts.some((post) => {
    if (!post.at || namesMatch(post.author, input.username)) return false;
    const age = ageDays(post.at, input.now);
    return age !== null && age >= 0 && age <= foreignDays;
  });
  if (!foreignRecent) return { ok: false, reason: "no_other_users" };
  let newest: WarmupPost | null = null;
  let newestAt = Number.NEGATIVE_INFINITY;
  for (const post of input.meta.posts) {
    if (!post.at) continue;
    const at = Date.parse(post.at);
    if (!Number.isFinite(at) || at < newestAt) continue;
    newestAt = at;
    newest = post;
  }
  if (newest && namesMatch(newest.author, input.username)) {
    return { ok: false, reason: "own_last" };
  }
  if (input.meta.closed) return { ok: false, reason: "closed" };
  return { ok: true };
}

/** Qualification writes `off_topic` instead of `qualified` when the page misses every lane. */
export function topicStatusForPage(status: string, page: TopicPage, project: TopicProject): string {
  if (status !== "qualified") return status;
  if (topicTerms(project).length === 0) return status;
  return pageMatchesTopics(page, project) ? status : "off_topic";
}
