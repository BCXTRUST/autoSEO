import type { AdapterContext, TextModel } from "@rakazo/adapter-kit";
import type {
  LbContent,
  LbDisclosureMode,
  LbLanguage,
  LbLinkRatio,
  LbPersona,
  LbTarget,
  LbTopicLane,
} from "@rakazo/contracts";
import { type LbWhyNot, LbWhyNotSchema } from "@rakazo/contracts";
import {
  type DraftContext,
  draftWithModel,
  relevanceTopicFromProject,
  type ModelComplete,
  type PreparedDraft,
  type ReferenceFormat,
  selectThreadCandidate,
  type ThreadSelection,
} from "@rakazo/linkbuilder-core";

export interface ComposeProject {
  persona: LbPersona;
  markets: ReadonlyArray<{ country: string; language: string }>;
  facts: readonly string[];
  targets: readonly LbTarget[];
  allowedDomains: readonly string[];
  content: LbContent;
  disclosureMode: LbDisclosureMode;
  linkRatio: LbLinkRatio;
  topicLanes: readonly LbTopicLane[];
}

export interface ComposeInput {
  title: string;
  excerpt: string;
  pageText: string;
  citeSource: boolean;
  signatureLinks: boolean;
  allowEmoji: boolean;
  bodyFormat: ReferenceFormat;
  laneId?: string | null;
  hostCountry: string;
  hostLanguage: string;
  postsOnHost: number;
  linkPostsOnHost: number;
  now: Date;
  lastActivityAt?: string | null;
}

export interface ComposeResult {
  draft: PreparedDraft;
  selection: ThreadSelection;
}

/** Drafts through the injected TextModel. Core owns the prompts and the checks. */
export async function composeReply(input: {
  model: TextModel;
  adapter: AdapterContext;
  project: ComposeProject;
  thread: ComposeInput;
}): Promise<ComposeResult> {
  const { model, project, thread } = input;
  const lane = project.topicLanes[0];
  const topic = relevanceTopicFromProject({
    topicLanes: project.topicLanes,
    targets: project.targets,
  });
  const market =
    project.markets.find(
      (item) => item.country === thread.hostCountry && item.language === thread.hostLanguage,
    ) ?? project.markets[0];
  if (!market) throw new Error("Project has no market");
  const language = (project.persona.language ?? market.language) as LbLanguage;
  const context: DraftContext = {
    displayName: project.persona.displayName,
    bio: project.persona.bio,
    register: project.persona.register,
    language,
    country: thread.hostCountry,
    toneNotes: project.content.toneNotes,
    facts: project.facts,
    targets: project.targets,
    allowedDomains: project.allowedDomains,
    title: thread.title,
    excerpt: thread.excerpt,
    laneTag: topic.tag,
    laneDescription: topic.description,
    citeSource: thread.citeSource,
    disclosureMode: project.disclosureMode,
    disclosureText: project.persona.disclosureText,
    content: project.content,
    linkRatio: project.linkRatio,
    postsOnHost: thread.postsOnHost,
    linkPostsOnHost: thread.linkPostsOnHost,
    signatureLinks: thread.signatureLinks,
    allowEmoji: thread.allowEmoji,
    bodyFormat: thread.bodyFormat,
  };
  const draft = await draftWithModel(
    ((request) => model.complete(request as never, input.adapter)) as ModelComplete,
    context,
  );
  const relevance = draft.relevance;
  const selection = relevance
    ? selectThreadCandidate({
        relevance: relevance.relevance,
        openQuestion: relevance.openQuestion,
        lastActivityAt: thread.lastActivityAt ? new Date(thread.lastActivityAt) : null,
        now: thread.now,
        activityDays: project.content.threadActivityDays,
        pageText: thread.pageText,
        allowedDomains: project.allowedDomains,
        laneId: thread.laneId ?? lane?.id ?? null,
        excludedLaneIds: project.content.excludedLaneIds,
      })
    : { selected: false, rejectReason: "model_relevance" };
  return { draft, selection };
}

export function bumpModelRefusal(existing: unknown): ReturnType<typeof LbWhyNotSchema.parse> {
  const parsed = LbWhyNotSchema.safeParse(existing);
  const base = parsed.success
    ? parsed.data
    : LbWhyNotSchema.parse({
        supply: { qualified: 0, ready: 0 },
        parked: 0,
        spamBlocked: 0,
        unsupportedCaptcha: 0,
        pendingEmail: 0,
        pendingAdmin: 0,
        modelErrors: 0,
        modelRefusals: 0,
        captchaBalance: null,
        proxy: "ok",
        reasons: [],
      });
  const reasons: LbWhyNot["reasons"] = base.reasons.includes("model_errors")
    ? base.reasons
    : [...base.reasons, "model_errors"];
  return { ...base, modelRefusals: base.modelRefusals + 1, reasons };
}
