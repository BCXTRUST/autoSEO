import type {
  LbDraftView,
  LbHostView,
  LbOperatorTicketView,
  LbPlacementView,
  LbProjectCard,
  LbProjectDetail,
  LbProjectStatusView,
  LbProxyLeaseView,
  LbRunStepView,
  LbThreadView,
} from "@rakazo/contracts";
import {
  FIXTURE_DEMO_SLUG,
  formatPackagePrice,
  mentionsExampleDomain,
  mentionsFixtureHost,
  primaryProblemQueryFromProject,
  showHostToCustomer,
  WORK_STAGE_LABELS,
  WORK_STAGES,
} from "@rakazo/linkbuilder-core";
import { useEffect, useRef, useState } from "react";
import {
  BuiButton,
  BuiCard,
  LoadingState,
  Shimmer,
  SuccessPop,
  TaskRow,
} from "../../components/beautiful-ui/primitives";
import {
  addWizardPage,
  disclosureLabel,
  draftFromProject,
  isSetupPlaceholder,
  normalizePageUrl,
  PAGE_BOX_LIMIT,
  pageDomains,
  QUOTA_LABELS,
  RESPONSIBILITY_SENTENCE,
  removeWizardPage,
  WIZARD_STEP_HINTS,
  WIZARD_STEPS,
  type WizardDraft,
  warmupNote,
  wizardStepIssues,
} from "./model.js";
import {
  cornerLabel,
  dashboardSummary,
  type doneCounts,
  homeLine,
  homeStatus,
  type OverviewFeedItem,
  type OverviewIntent,
  overviewAction,
  overviewFeed,
  overviewFrame,
  overviewHasPlacement,
  overviewStage,
  overviewWorking,
  personTicket,
  showOnDashboard,
  stuckHelp,
  waitLines,
  whyNotFeedLines,
} from "./overview.js";

const inputClass =
  "w-full rounded-xl border border-[#2A2A31] bg-[#141416] px-3 py-2 text-[14px] text-[#ECECEE] outline-none";

/** Host, status, and task text. Empty query keeps every row. */
export function matchesTaskQuery(query: string, parts: Array<string | null | undefined>): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return parts.some((part) => (part ?? "").replaceAll("_", " ").toLowerCase().includes(needle));
}

export function DashboardView({
  cards,
  loading,
  onOpen,
  onNew,
  onHelp,
}: {
  cards: LbProjectCard[];
  loading: boolean;
  onOpen: (card: LbProjectCard) => void;
  onNew: () => void;
  onHelp?: (card: LbProjectCard) => void;
}) {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-8">
      <header className="flex items-center justify-between">
        <h1 className="text-[22px] font-medium text-[#ECECEE]">Link Builder</h1>
        <BuiButton tone="accent" label="New project" onClick={onNew}>
          New project
        </BuiButton>
      </header>
      {loading ? <LoadingState label="Loading projects" /> : null}
      <div className="grid gap-3 md:grid-cols-2">
        {cards.map((card) => {
          const help = card.operatorHelp ?? null;
          const status = homeStatus({
            activity: card.activity,
            activityLabel: card.activityLabel,
            needsYou: Boolean(help),
          });
          return (
            <BuiCard key={card.id} className="flex flex-col gap-3 p-4">
              <div className="flex items-start justify-between gap-3">
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  aria-label={`Open ${card.name}`}
                  onClick={() => onOpen(card)}
                >
                  <div className="text-[16px] text-[#ECECEE]">{card.name}</div>
                  <div className="text-[12.5px] text-[#85858A]">{card.brandName}</div>
                </button>
                <Pill label={status} />
                {help && onHelp ? (
                  <button
                    type="button"
                    className="rounded-full bg-[#232327] px-2 py-1 text-left text-[12px] text-[#ECECEE]"
                    aria-label={help.label}
                    onClick={() => onHelp(card)}
                  >
                    {help.label}
                  </button>
                ) : null}
              </div>
              <button
                type="button"
                className="text-left"
                aria-label={`Open ${card.name}`}
                onClick={() => onOpen(card)}
              >
                <p className="text-[14px] text-[#ECECEE]">
                  {homeLine({
                    status,
                    liveToday: card.liveToday,
                    livePerDay: card.livePerDay,
                  })}
                </p>
              </button>
            </BuiCard>
          );
        })}
      </div>
    </main>
  );
}

export function CreditPackagesView({
  packages,
  balance,
  reason,
  busy,
  onBuy,
}: {
  packages: Array<{
    id: string;
    name: string;
    credits: number;
    priceCents: number;
    currency: "eur";
    recommended: boolean;
  }>;
  balance: number;
  reason: string;
  busy: boolean;
  onBuy: (packageId: string) => void;
}) {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-2">
        <ol aria-label="Setup" className="flex gap-3 text-[13px]">
          <li className="text-[#3dbb72]">Account</li>
          <li aria-current="step" className="text-[#ECECEE]">
            Credits
          </li>
          <li className="text-[#85858A]">Project</li>
        </ol>
        <h1 className="text-[22px] font-medium text-[#ECECEE]">Credits</h1>
      </header>
      <p className="text-[13px] text-[#ECECEE]">
        <span className="tabular-nums">{balance}</span>
        <span className="text-[#A6A6AD]"> credits</span>
      </p>
      <div className="grid gap-3 md:grid-cols-3">
        {packages.map((pack) => (
          <BuiCard
            key={pack.id}
            className="flex flex-col gap-3 p-4"
            data-recommended={pack.recommended ? "true" : "false"}
            style={
              pack.recommended
                ? { boxShadow: "0 0 0 1px var(--bui-accent), 0 8px 24px #00000055" }
                : undefined
            }
          >
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-[16px] text-[#ECECEE]">{pack.name}</h2>
              {pack.recommended ? (
                <span className="text-[12px] text-[#7785ff]">Recommended</span>
              ) : null}
            </div>
            <div className="text-[28px] font-medium text-[#ECECEE]">
              {formatPackagePrice(pack.priceCents, pack.currency)}
            </div>
            <p className="text-[13px] text-[#A6A6AD]">
              {pack.credits.toLocaleString("en-US")} credits
            </p>
            <BuiButton
              tone={pack.recommended ? "accent" : "neutral"}
              label={`Buy ${pack.name}`}
              disabled={busy}
              onClick={() => onBuy(pack.id)}
            >
              Buy
            </BuiButton>
          </BuiCard>
        ))}
      </div>
      {reason ? (
        <p role="status" className="text-[13px] text-[#A6A6AD]">
          {reason}
        </p>
      ) : null}
    </main>
  );
}

export function WizardView({
  step,
  draft,
  issues,
  busy,
  started,
  onChange,
  onBack,
  onNext,
  onStart,
  onGoTo,
  onSuggestPage,
}: {
  step: number;
  draft: WizardDraft;
  issues: string[];
  busy: boolean;
  started: boolean;
  onChange: (next: WizardDraft | ((current: WizardDraft) => WizardDraft)) => void;
  onBack: () => void;
  onNext: () => void;
  onStart: () => void;
  onGoTo: (step: number) => void;
  onSuggestPage?: (input: {
    url: string;
    allowedDomains: string[];
  }) => Promise<{ keyword: string; rule: string }>;
}) {
  const title = WIZARD_STEPS[step] ?? "Start";
  const last = WIZARD_STEPS.length - 1;
  return (
    <main
      className="grid h-full min-h-dvh w-full min-w-0 overflow-x-clip bg-[#050506]"
      style={{ gridTemplateColumns: "280px minmax(0, 1fr)" }}
    >
      <ol
        aria-label="Setup steps"
        className="flex min-w-0 flex-col gap-0.5 overflow-y-auto border-r border-[#2A2A31] px-3 py-8"
        style={{ position: "sticky", top: 0, height: "100vh", alignSelf: "start" }}
      >
        {WIZARD_STEPS.map((label, index) => {
          const current = index === step;
          const done = index < step;
          return (
            <li key={label}>
              <button
                type="button"
                aria-current={current ? "step" : undefined}
                aria-label={`Step ${index + 1} of ${WIZARD_STEPS.length}: ${label}${done ? ", done" : ""}`}
                disabled={busy || index > step}
                onClick={() => onGoTo(index)}
                className={`flex w-full min-w-0 items-start gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] leading-snug ${
                  current
                    ? "bg-[#1C1C20] text-[#ECECEE] shadow-[inset_2px_0_0_#7785ff]"
                    : done
                      ? "text-[#C8C8CD] hover:bg-[#141416]"
                      : "text-[#85858A]"
                } disabled:hover:bg-transparent`}
              >
                <StepMark index={index} done={done} />
                <span className="min-w-0 flex-1 whitespace-normal break-words">{label}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <div className="rk-scroll min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-6 py-8">
          <h1 className="text-[22px] font-medium text-[#ECECEE]">{title}</h1>
          <p className="text-[13px] text-[#A6A6AD]">{WIZARD_STEP_HINTS[step]}</p>
          {step === 3 ? (
            <TopicFields draft={draft} onChange={onChange} onSuggestPage={onSuggestPage} />
          ) : (
            <BuiCard className="flex flex-col gap-3 p-4">
              {step === 0 ? <BrandFields draft={draft} onChange={onChange} /> : null}
              {step === 1 ? (
                <PersonaFields draft={draft} onChange={onChange} showMail={false} />
              ) : null}
              {step === 2 ? (
                <QuotaFields draft={draft} onChange={onChange} showAccounts={false} />
              ) : null}
              {step === last ? <ReviewFields draft={draft} /> : null}
            </BuiCard>
          )}
          {issues.length > 0 ? (
            <ul className="flex flex-col gap-1 text-[13px] text-[#FF8B8B]" role="alert">
              {issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <BuiButton label="Back" onClick={onBack} disabled={step === 0 || busy}>
              Back
            </BuiButton>
            {step < last ? (
              <BuiButton tone="accent" label="Continue" onClick={onNext} disabled={busy}>
                Continue
              </BuiButton>
            ) : (
              <div className="flex flex-col items-end gap-2">
                {started ? <SuccessPop label="Started" /> : null}
                <BuiButton tone="accent" label="Start" onClick={onStart} disabled={busy}>
                  Start
                </BuiButton>
                <p className="max-w-sm text-right text-[12px] text-[#85858A]">
                  {RESPONSIBILITY_SENTENCE}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

function StepMark({ index, done }: { index: number; done: boolean }) {
  if (done) {
    return (
      <svg
        className="mt-0.5 shrink-0"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#3dbb72"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M20 6 9 17 4 12" />
      </svg>
    );
  }
  return <span className="mt-0.5 w-3.5 shrink-0 text-center tabular-nums">{index + 1}</span>;
}

export type ProjectSurface = "dashboard" | "details" | "settings";

export function ProjectView({
  project,
  status,
  hosts,
  placements,
  steps,
  threads,
  drafts,
  leases = [],
  tickets,
  surface,
  onSurface,
  onStart,
  onPause,
  onStop: _onStop,
  onInstruct: _onInstruct,
  onDecideDraft,
  onSave,
  onSuggestPage,
  loadArtifact,
  busy,
  creditNote,
  onBuyCredits,
  screenUrl,
  screenError,
  screenPending,
  onHelp,
  onFixed,
}: {
  project: LbProjectDetail;
  status: LbProjectStatusView | null;
  hosts: LbHostView[];
  placements: LbPlacementView[];
  steps: LbRunStepView[];
  threads: LbThreadView[];
  drafts: LbDraftView[];
  leases?: LbProxyLeaseView[];
  tickets: LbOperatorTicketView[];
  surface: ProjectSurface;
  onSurface: (surface: ProjectSurface) => void;
  onStart: () => void;
  onPause: () => void;
  onStop: () => void;
  onInstruct?: (phrase: string) => Promise<void>;
  onFixed?: (ticketId: string) => void;
  onDecideDraft?: (draftId: string, decision: "approved" | "discarded") => void;
  onSave?: (draft: WizardDraft) => void | Promise<void>;
  onSuggestPage?: (input: {
    url: string;
    allowedDomains: string[];
  }) => Promise<{ keyword: string; rule: string }>;
  loadArtifact?: ArtifactLoader;
  busy: boolean;
  creditNote?: string | null;
  onBuyCredits?: () => void;
  screenUrl?: string | null;
  screenError?: string | null;
  screenPending?: boolean;
  onHelp?: () => void;
}) {
  const [intent, setIntent] = useState<OverviewIntent>(null);
  useEffect(() => {
    if (!intent || busy) return;
    setIntent(null);
  }, [intent, busy]);
  const working = overviewWorking({ activity: status?.activity ?? null, intent });
  const help = status?.operatorHelp ?? null;
  const needed = personTicket(tickets);
  const stuck = needed ? stuckHelp(needed) : null;
  const statusWord = homeStatus({
    activity: status?.activity ?? null,
    activityLabel: status?.activityLabel ?? null,
    intent,
    needsYou: Boolean(help) || Boolean(needed),
  });
  function request(kind: "start" | "pause") {
    const next: OverviewIntent = kind === "start" ? "working" : "paused";
    setIntent(next);
    const run = kind === "start" ? onStart() : onPause();
    void Promise.resolve(run).catch(() => setIntent(null));
  }
  const watching = surface === "dashboard";
  const summary = dashboardSummary({
    hosts,
    placements,
    steps,
    slug: project.slug,
    whyNot: status?.whyNot,
  });
  return (
    <main
      className={
        watching
          ? "mx-auto flex h-dvh w-full max-w-[1400px] flex-col gap-4 overflow-hidden px-4 py-4"
          : "mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6"
      }
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        {watching ? (
          <h1 className="text-[22px] font-medium text-[#ECECEE]">{project.name}</h1>
        ) : (
          <button
            type="button"
            aria-label="Dashboard"
            className="text-left text-[22px] font-medium text-[#ECECEE]"
            onClick={() => onSurface("dashboard")}
          >
            {project.name}
          </button>
        )}
        <div className="flex flex-wrap items-start gap-3">
          <Pill label={statusWord} />
          {help && onHelp && !stuck ? (
            <button
              type="button"
              className="rounded-full bg-[#232327] px-2 py-1 text-[12px] text-[#ECECEE]"
              aria-label={help.label}
              onClick={onHelp}
            >
              {help.label}
            </button>
          ) : null}
          <CreditBudget
            balance={status?.credits?.balance ?? null}
            note={creditNote}
            busy={busy}
            onBuy={onBuyCredits}
          />
        </div>
      </header>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <BuiButton tone="accent" label="Start" onClick={() => request("start")} disabled={busy}>
            Start
          </BuiButton>
          <BuiButton label="Pause" onClick={() => request("pause")} disabled={busy}>
            Pause
          </BuiButton>
          <BuiButton label="Change schedule" onClick={() => onSurface("settings")} disabled={busy}>
            Change schedule
          </BuiButton>
          <BuiButton label="Details" onClick={() => onSurface("details")} disabled={busy}>
            Details
          </BuiButton>
        </div>
        {watching ? (
          <DoneStrip
            done={summary.done}
            notes={summary.notes}
            links={{
              value: status?.run?.liveToday ?? 0,
              max: status?.livePerDay ?? project.quotas?.livePerDay ?? 0,
            }}
            onOpen={() => onSurface("details")}
          />
        ) : null}
      </div>
      {stuck && needed ? (
        <section
          aria-label="Needs you"
          className="rounded-2xl border border-[#2A2A31] bg-[#141416] p-4"
        >
          <p className="text-[15px] text-[#ECECEE]">{stuck.stuck}</p>
          <p className="mt-1 text-[13px] text-[#A6A6AD]">{stuck.next}</p>
          <div className="mt-3">
            <BuiButton
              tone="accent"
              label="I fixed it, continue"
              disabled={busy || !onFixed}
              onClick={() => onFixed?.(needed.id)}
            >
              I fixed it, continue
            </BuiButton>
          </div>
        </section>
      ) : null}
      {watching ? (
        <Dashboard
          project={project}
          status={status}
          hosts={hosts}
          placements={placements}
          steps={steps}
          threads={threads}
          drafts={drafts}
          tickets={tickets}
          working={working}
          screenUrl={screenUrl}
          screenError={screenError}
          screenPending={screenPending}
          loadArtifact={loadArtifact}
        />
      ) : surface === "details" ? (
        <DetailsView
          project={project}
          status={status}
          hosts={hosts}
          placements={placements}
          steps={steps}
          threads={threads}
          drafts={drafts}
          onDecideDraft={onDecideDraft}
        />
      ) : (
        <SettingsPanel
          project={project}
          leases={leases}
          busy={busy}
          onSave={onSave}
          onSuggestPage={onSuggestPage}
        />
      )}
    </main>
  );
}

export function ticketCountdown(expiresAt: string | null, now = Date.now()): string | null {
  if (!expiresAt) return null;
  const remaining = Date.parse(expiresAt) - now;
  if (Number.isNaN(remaining)) return null;
  if (remaining <= 0) return "Expired";
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function OperatorView({
  ticket,
  note,
  busy,
  done,
  onNote,
  onContinue,
  onSkip,
  loadArtifact,
  now,
}: {
  ticket: LbOperatorTicketView;
  note: string;
  busy: boolean;
  done: string | null;
  onNote: (note: string) => void;
  onContinue: () => void;
  onSkip: () => void;
  loadArtifact?: ArtifactLoader;
  now?: number;
}) {
  const embed = ticket.screenUrl?.startsWith("/novnc/") || ticket.screenUrl?.startsWith("https://");
  const shot = !embed && loadArtifact ? ticket.screenshotArtifactId : null;
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-8">
      <h1 className="text-[22px] font-medium text-[#ECECEE]">{ticket.domain}</h1>
      {ticketCountdown(ticket.expiresAt, now) ? (
        <p className="text-[13px] text-[#A6A6AD]">{ticketCountdown(ticket.expiresAt, now)}</p>
      ) : null}
      {shot && loadArtifact ? (
        <ArtifactShot artifactId={shot} load={loadArtifact} label="Screenshot" />
      ) : (
        <div
          role="img"
          className="grid min-h-[320px] place-items-center overflow-hidden rounded-[16px] border border-[#2A2A31] bg-[#101012]"
          aria-label="Live screen"
        >
          {embed && ticket.screenUrl ? (
            <iframe title="Live screen" src={ticket.screenUrl} className="h-[420px] w-full" />
          ) : (
            <span className="text-[13px] text-[#85858A]">Live screen</span>
          )}
        </div>
      )}
      <p className="text-[15px] text-[#ECECEE]">{stuckHelp(ticket).stuck}</p>
      <p className="text-[13px] text-[#A6A6AD]">{stuckHelp(ticket).next}</p>
      <label className="text-[13px] text-[#A6A6AD]">
        Note
        <textarea
          aria-label="Note"
          value={note}
          onChange={(event) => onNote(event.target.value)}
          className={`${inputClass} mt-1 min-h-20`}
        />
      </label>
      {done ? <SuccessPop label={done} /> : null}
      <div className="flex gap-3">
        <BuiButton tone="accent" label="I fixed it, continue" onClick={onContinue} disabled={busy}>
          I fixed it, continue
        </BuiButton>
        <BuiButton label="Skip host" onClick={onSkip} disabled={busy}>
          Skip host
        </BuiButton>
      </div>
    </main>
  );
}

function Dashboard({
  project,
  status,
  hosts,
  placements,
  steps,
  threads,
  drafts,
  tickets,
  working,
  screenUrl,
  screenError,
  screenPending,
  loadArtifact,
}: {
  project: LbProjectDetail;
  status: LbProjectStatusView | null;
  hosts: LbHostView[];
  placements: LbPlacementView[];
  steps: LbRunStepView[];
  threads: LbThreadView[];
  drafts: LbDraftView[];
  tickets: LbOperatorTicketView[];
  working: boolean;
  screenUrl?: string | null;
  screenError?: string | null;
  screenPending?: boolean;
  loadArtifact?: ArtifactLoader;
}) {
  const hideExampleCopy = project.slug !== FIXTURE_DEMO_SLUG;
  const visiblePlacements = placements.filter((row) =>
    showHostToCustomer(row.domain, project.slug),
  );
  const hasPlacement = overviewHasPlacement(
    visiblePlacements.map((row) => row.domain),
    project.slug,
  );
  const forums = hosts.filter((host) => showHostToCustomer(host.registrableDomain, project.slug));
  const visibleThreads = threads.filter((thread) =>
    showHostToCustomer(thread.domain, project.slug),
  );
  const visibleDrafts = drafts.filter((draft) => customerDraft(draft, hideExampleCopy));
  const draftBodies = new Set(visibleDrafts.map((draft) => draft.body.trim()));
  const searches = status?.costs?.day.searchQueries ?? 0;
  const items = overviewFeed({
    steps,
    lastEvent: status?.lastEvent ?? null,
    working,
    blockers: whyNotFeedLines(status?.whyNot),
    hideExampleCopy,
    hasPlacement,
    forumName: forums[0]?.registrableDomain ?? null,
    threadName: visibleThreads[0]?.title ?? null,
    searches,
    searchQuery: primaryProblemQueryFromProject(project),
  }).filter((item) => !draftBodies.has(item.label.trim()) && showOnDashboard(item.label));
  const taskColumn = useRef<HTMLDivElement>(null);
  const feedTail = `${items.length}:${items[items.length - 1]?.id ?? ""}`;
  useEffect(() => {
    const node = taskColumn.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [feedTail]);
  const frame = overviewFrame({ steps, tickets, screenUrl });
  const action = overviewAction(
    items,
    working,
    frame?.kind === "url" ? (status?.run?.currentUrl ?? null) : null,
  );
  const stage = overviewStage({
    runStatus: working ? "running" : (status?.run?.status ?? null),
    lastAction: status?.run?.lastAction ?? status?.lastEvent ?? action ?? null,
    stepKinds: steps.map((step) => step.kind),
    hasPlacement,
  });
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4" aria-label="Dashboard">
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.55fr)_minmax(240px,380px)] gap-4">
        <ComputerPane
          working={working}
          action={cornerLabel(action, WORK_STAGE_LABELS[stage])}
          stage={stage}
          frame={frame}
          screenError={screenError}
          screenPending={screenPending}
          loadArtifact={loadArtifact}
        />
        <div
          ref={taskColumn}
          data-task-column=""
          className="rk-scroll flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain"
        >
          <ActivityFeed items={items} />
        </div>
      </div>
    </section>
  );
}

function DoneStrip({
  done,
  notes,
  links,
  onOpen,
}: {
  done: ReturnType<typeof doneCounts>;
  notes: { id: string; text: string }[];
  links: { value: number; max: number };
  onOpen: () => void;
}) {
  const counts = [
    ["registered", done.registered],
    ["posted", done.posted],
    ["skipped", done.skipped],
  ] as const;
  return (
    <button type="button" aria-label="Done" className="max-w-[28rem] text-right" onClick={onOpen}>
      <span className="block text-[13px] text-[#ECECEE]">
        {counts.map(([label, value], index) => (
          <span key={label}>
            {index > 0 ? <span className="text-[#5E5E66]"> · </span> : null}
            <span className="tabular-nums">{value}</span> {label}
          </span>
        ))}
      </span>
      {notes.map((note) => (
        <span key={note.id} className="mt-0.5 block truncate text-[12.5px] text-[#A6A6AD]">
          {note.text}
        </span>
      ))}
      <span className="mt-0.5 block text-[12.5px] text-[#A6A6AD]">
        Links that count{" "}
        <span className="text-[15px] tabular-nums text-[#ECECEE]">{`${links.value}/${links.max}`}</span>
      </span>
    </button>
  );
}

function DetailsView({
  project,
  status,
  hosts,
  placements,
  steps,
  threads,
  drafts,
  onDecideDraft,
}: {
  project: LbProjectDetail;
  status: LbProjectStatusView | null;
  hosts: LbHostView[];
  placements: LbPlacementView[];
  steps: LbRunStepView[];
  threads: LbThreadView[];
  drafts: LbDraftView[];
  onDecideDraft?: (draftId: string, decision: "approved" | "discarded") => void;
}) {
  const hideExampleCopy = project.slug !== FIXTURE_DEMO_SLUG;
  const forums = hosts.filter((host) => showHostToCustomer(host.registrableDomain, project.slug));
  const visibleThreads = threads.filter((thread) =>
    showHostToCustomer(thread.domain, project.slug),
  );
  const visiblePlacements = placements.filter((row) =>
    showHostToCustomer(row.domain, project.slug),
  );
  const visibleDrafts = drafts.filter((draft) => customerDraft(draft, hideExampleCopy));
  const waits = waitLines({ hosts, steps, slug: project.slug });
  return (
    <section className="flex flex-col gap-4" aria-label="Details">
      <section aria-label="Waiting" className="flex flex-col gap-2">
        <h2 className="text-[12px] text-[#8A8A90]">Waiting</h2>
        {waits.length === 0 ? (
          <p className="text-[13px] text-[#8A8A90]">Nothing is waiting.</p>
        ) : (
          waits.map((wait) => (
            <p key={wait.id} className="text-[14px] text-[#ECECEE]">
              {wait.text}
            </p>
          ))
        )}
      </section>
      <ForumsPicked hosts={forums} threads={visibleThreads} />
      <LinksPlaced rows={visiblePlacements} />
      <DraftNotes
        drafts={visibleDrafts}
        draftsOnly={project.disclosureMode === "drafts_only"}
        onDecide={onDecideDraft}
      />
      {status?.costs ? <CostNote costs={status.costs} /> : null}
    </section>
  );
}

function ComputerPane({
  working,
  action,
  stage,
  frame,
  screenError,
  screenPending,
  loadArtifact,
}: {
  working: boolean;
  action: string;
  stage: (typeof WORK_STAGES)[number];
  frame: ReturnType<typeof overviewFrame>;
  screenError?: string | null;
  screenPending?: boolean;
  loadArtifact?: ArtifactLoader;
}) {
  const label = action || WORK_STAGE_LABELS[stage];
  const stageIndex = WORK_STAGES.indexOf(stage);
  const session = frame ? "open" : "closed";
  return (
    <section
      aria-label="Computer"
      data-frame={frame?.kind ?? "pending"}
      data-stage={stage}
      data-session={session}
      className="relative flex min-h-0 flex-col overflow-hidden rounded-[16px] bg-[#0c0c0e]"
      style={{ boxShadow: "var(--bui-shadow-card)" }}
    >
      <div className="flex h-11 items-center gap-3 border-b border-[#2A2A31] px-3.5">
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: working ? "var(--bui-green)" : "#3a3a40" }}
        />
        <ol aria-label="Stage" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {WORK_STAGES.map((name, index) => {
            const current = name === stage;
            const done = index < stageIndex;
            return (
              <li
                key={name}
                aria-current={current ? "step" : undefined}
                className={`shrink-0 whitespace-nowrap rounded-full px-2 py-1 text-[12px] leading-none sm:px-2.5 sm:text-[12.5px] ${
                  current
                    ? "bg-[#232327] text-[#ECECEE]"
                    : done
                      ? "text-[#C8C8CD]"
                      : "text-[#5E5E66]"
                }`}
              >
                {current && working ? (
                  <Shimmer>{WORK_STAGE_LABELS[name]}</Shimmer>
                ) : (
                  WORK_STAGE_LABELS[name]
                )}
              </li>
            );
          })}
        </ol>
        <span className="hidden shrink-0 sm:flex">
          <PixelTrail live={working && session === "closed"} />
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
        {frame?.kind === "url" ? (
          <iframe
            title="Computer"
            src={watchingFrameSrc(frame.url)}
            className="absolute inset-0 h-full w-full border-0 bg-black"
            sandbox={computerFrameSandbox(frame.url)}
            allow="fullscreen"
            style={{ pointerEvents: "none" }}
          />
        ) : (
          <WorkingScreen
            working={working}
            label={label}
            stage={stage}
            closed={session === "closed"}
            screenError={screenError}
            screenPending={screenPending}
          />
        )}
        {frame?.kind === "artifact" && loadArtifact ? (
          <ArtifactShot
            artifactId={frame.artifactId}
            load={loadArtifact}
            label="Computer"
            untilReady="blank"
            className="absolute inset-0 z-[1] h-full w-full bg-[#0c0c0e] object-contain"
          />
        ) : null}
        {frame && label ? (
          <div
            data-live-status="corner"
            className="pointer-events-none absolute top-4 right-4 z-20 max-w-[min(100%-2rem,24rem)] rounded-full bg-[#0c0c0e]/92 px-3 py-2"
          >
            {working ? (
              <LoadingState label={label} />
            ) : (
              <p className="text-[13.5px] font-medium leading-snug text-[#ECECEE]">{label}</p>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * noVNC joins `wss://host/` with `path`, so a page under `/novnc/.../vnc.html`
 * must name the websocket or it dials the site root and shows "Failed to connect".
 */
export function novncClientPath(pathname: string): string | null {
  const page = pathname.replace(/\/+$/, "");
  if (!page.includes("/novnc/")) return null;
  if (!/\/(?:vnc|embed)\.html$/.test(page)) return null;
  return `${page.replace(/^\//, "").replace(/\/(?:vnc|embed)\.html$/, "")}/websockify`;
}

/** noVNC reads autoconnect and path from the iframe URL. The proxy keeps provider secrets in the path. */
export function watchingFrameSrc(url: string): string {
  try {
    const parsed = new URL(url, "https://app.autoseo.run");
    const page = parsed.pathname.endsWith("/vnc.html") || parsed.pathname.endsWith("/embed.html");
    if (!page) return url;
    parsed.searchParams.set("autoconnect", "true");
    parsed.searchParams.set("reconnect", "true");
    parsed.searchParams.set("resize", "scale");
    parsed.searchParams.set("view_only", "true");
    const wsPath = novncClientPath(parsed.pathname);
    if (wsPath) parsed.searchParams.set("path", wsPath);
    if (url.startsWith("http://") || url.startsWith("https://")) return parsed.toString();
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function computerFrameSandbox(url: string): string | undefined {
  try {
    return new URL(url, "https://app.local").pathname.startsWith("/novnc/")
      ? "allow-scripts allow-same-origin allow-pointer-lock"
      : undefined;
  } catch {
    return undefined;
  }
}

function WorkingScreen({
  working,
  label,
  stage,
  closed,
  screenError,
  screenPending,
}: {
  working: boolean;
  label: string;
  stage: (typeof WORK_STAGES)[number];
  closed: boolean;
  screenError?: string | null;
  screenPending?: boolean;
}) {
  return (
    <section
      aria-label={label}
      className="flex h-full min-h-0 items-start justify-end bg-[#0c0c0e] p-4"
    >
      <BuiCard className="flex w-fit max-w-md flex-col gap-3 px-4 py-3">
        <p className="text-[13px] text-[#8A8A90]">{WORK_STAGE_LABELS[stage]}</p>
        {screenError ? (
          <p className="text-[22px] font-medium leading-none text-[#ECECEE]">{screenError}</p>
        ) : working ? (
          <LoadingState label={label} prominent />
        ) : (
          <p className="text-[22px] font-medium leading-none text-[#ECECEE]">{label}</p>
        )}
        {screenError ? null : screenPending ? (
          <p className="text-[12px] text-[#6C6C70]">Starting computer</p>
        ) : closed ? (
          <p className="text-[12px] text-[#6C6C70]">No session</p>
        ) : null}
      </BuiCard>
    </section>
  );
}

/** A few pixels and a short dot trail. A hint, not a maze. */
function PixelTrail({ live }: { live: boolean }) {
  return (
    <span aria-hidden data-pixel="trail" className="flex shrink-0 items-center gap-[5px]">
      <span
        className="block h-2 w-2"
        style={{
          background: live ? "#C8C8CD" : "#3a3a40",
          clipPath: "polygon(0 0, 100% 0, 100% 35%, 58% 50%, 100% 65%, 100% 100%, 0 100%)",
        }}
      />
      {[0.7, 0.45, 0.22].map((opacity, index) => (
        <span
          key={index}
          className="block h-[3px] w-[3px] rounded-[1px]"
          style={{ background: "#C8C8CD", opacity: live ? opacity : 0.25 }}
        />
      ))}
    </span>
  );
}

function ActivityFeed({ items }: { items: OverviewFeedItem[] }) {
  return (
    <section className="min-h-0 shrink-0" aria-label="Activity" aria-live="polite">
      <BuiCard className="overflow-hidden">
        {items.length === 0 ? (
          <p className="px-3 py-4 text-[13px] text-[#85858A]">No events yet</p>
        ) : (
          items.map((item) => (
            <TaskRow
              key={item.id}
              status={item.status}
              label={item.label}
              meta={feedMeta(item.at)}
            />
          ))
        )}
      </BuiCard>
    </section>
  );
}

function feedMeta(at: string | null): string | undefined {
  if (!at) return undefined;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function CostNote({ costs }: { costs: NonNullable<LbProjectStatusView["costs"]> }) {
  const line = (label: string, row: LbProjectStatusView["costs"]["day"]) =>
    `${label} ${row.modelTokens} tokens · ${row.searchQueries} searches · ${row.proxyLeaseDays} proxy days`;
  return (
    <p className="text-[12px] text-[#6C6C70]">
      {line("Today", costs.day)}
      <span className="mx-2">·</span>
      {line("Week", costs.week)}
    </p>
  );
}

function ForumsPicked({ hosts, threads }: { hosts: LbHostView[]; threads: LbThreadView[] }) {
  if (hosts.length === 0 && threads.length === 0) return null;
  return (
    <section aria-label="Forums" className="flex flex-col gap-2">
      <h2 className="text-[12px] text-[#8A8A90]">Forums</h2>
      <BuiCard className="flex max-h-40 flex-col overflow-y-auto">
        {hosts.map((host) => (
          <div
            key={host.id}
            className="flex items-baseline justify-between gap-3 border-b border-[#2A2A31] px-3 py-2 text-[13px] last:border-b-0"
          >
            <span className="text-[#ECECEE]">{host.registrableDomain}</span>
          </div>
        ))}
        {threads.map((thread) => (
          <div
            key={thread.id}
            className="break-words border-b border-[#2A2A31] px-3 py-2 text-[13px] text-[#C8C8CD] last:border-b-0"
          >
            {thread.title}
          </div>
        ))}
      </BuiCard>
    </section>
  );
}

function LinksPlaced({ rows }: { rows: LbPlacementView[] }) {
  if (rows.length === 0) return null;
  return (
    <section aria-label="Links placed" className="flex flex-col gap-2">
      <h2 className="text-[12px] text-[#8A8A90]">Links</h2>
      <BuiCard className="flex max-h-36 flex-col overflow-y-auto">
        {rows.map((row) => (
          <div
            key={row.id}
            className="flex items-baseline justify-between gap-3 border-b border-[#2A2A31] px-3 py-2 text-[13px] last:border-b-0"
          >
            <span className="text-[#ECECEE]">{row.domain}</span>
            <span className="text-[12px] text-[#8A8A90]">{row.status}</span>
          </div>
        ))}
      </BuiCard>
    </section>
  );
}

const FIXTURE_DRAFT_BODY = "Eine feste Uhrzeit hilft oft. Das hier erklärt es ganz gut.";

function customerDraft(
  draft: { body: string; targetUrl: string | null; anchorText: string | null; modelId: string },
  hideExampleCopy: boolean,
): boolean {
  if (!hideExampleCopy) return true;
  if (draft.modelId === "fake-draft") return false;
  if (draft.body.trim() === FIXTURE_DRAFT_BODY) return false;
  const text = `${draft.body} ${draft.targetUrl ?? ""} ${draft.anchorText ?? ""}`;
  return !mentionsExampleDomain(text) && !mentionsFixtureHost(text);
}

function DraftNotes({
  drafts,
  draftsOnly,
  onDecide,
}: {
  drafts: LbDraftView[];
  draftsOnly: boolean;
  onDecide?: (draftId: string, decision: "approved" | "discarded") => void;
}) {
  if (drafts.length === 0) return null;
  return (
    <section aria-label="Drafts" className="flex flex-col gap-2">
      {drafts.map((draft) => (
        <BuiCard key={draft.id} className="flex flex-col gap-2 p-3 text-[13px] text-[#C9C9CE]">
          <p className="break-words">{draft.body}</p>
          {draftsOnly && draft.status === "drafted" && onDecide ? (
            <div className="flex gap-2">
              <BuiButton label="Approve draft" onClick={() => onDecide(draft.id, "approved")}>
                Approve
              </BuiButton>
              <BuiButton label="Discard draft" onClick={() => onDecide(draft.id, "discarded")}>
                Discard
              </BuiButton>
            </div>
          ) : null}
        </BuiCard>
      ))}
    </section>
  );
}

/** Resolves an artifact id to an image URL, or null when the artifact is not an image. */
export type ArtifactLoader = (artifactId: string) => Promise<string | null>;

export function ArtifactShot({
  artifactId,
  load,
  label,
  className = "w-full rounded-[12px] border border-[#2A2A31]",
  untilReady = "loader",
}: {
  artifactId: string;
  load: ArtifactLoader;
  label: string;
  className?: string;
  /** `blank` keeps the surrounding pane visible until the image arrives. */
  untilReady?: "loader" | "blank";
}) {
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setSrc(undefined);
    load(artifactId)
      .then((next) => {
        if (live) setSrc(next);
      })
      .catch(() => {
        if (live) setSrc(null);
      });
    return () => {
      live = false;
    };
  }, [artifactId, load]);
  if (src === undefined) return untilReady === "blank" ? null : <LoadingState label={label} />;
  if (src === null) return null;
  return <img src={src} alt={label} className={className} />;
}

function SettingsPanel({
  project,
  leases,
  busy,
  onSave,
  onSuggestPage,
}: {
  project: LbProjectDetail;
  leases: LbProxyLeaseView[];
  busy: boolean;
  onSave?: (draft: WizardDraft) => void | Promise<void>;
  onSuggestPage?: (input: {
    url: string;
    allowedDomains: string[];
  }) => Promise<{ keyword: string; rule: string }>;
}) {
  const editable = Boolean(project.schedule && project.allowedDomains && project.linkRatio);
  const [draft, setDraft] = useState<WizardDraft | null>(() =>
    editable ? draftFromProject(project) : null,
  );
  const [issues, setIssues] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  function edit(next: WizardDraft | ((current: WizardDraft) => WizardDraft)) {
    setSaved(false);
    setDraft((current) => {
      if (!current) return current;
      return typeof next === "function" ? next(current) : next;
    });
  }
  async function save() {
    if (!draft || !onSave) return;
    const found = [0, 1, 2, 3].flatMap((step) => wizardStepIssues(step, draft));
    setIssues(found);
    if (found.length > 0) return;
    try {
      await onSave(draft);
      setSaved(true);
    } catch (err) {
      setIssues([err instanceof Error ? err.message : "Could not save"]);
    }
  }
  return (
    <section aria-label="Settings" className="flex flex-col gap-4">
      {draft ? (
        <>
          <div className="flex flex-col gap-3">
            <h2 className="text-[13px] text-[#A6A6AD]">Pages</h2>
            <TopicFields draft={draft} onChange={edit} onSuggestPage={onSuggestPage} />
          </div>
          <BuiCard className="flex flex-col gap-3 p-4">
            <h2 className="text-[13px] text-[#A6A6AD]">Quotas</h2>
            <QuotaFields draft={draft} onChange={(next) => edit(next)} />
            <ScheduleFields draft={draft} onChange={(next) => edit(next)} />
          </BuiCard>
          <BuiCard className="flex flex-col gap-3 p-4">
            <h2 className="text-[13px] text-[#A6A6AD]">Persona</h2>
            <PersonaFields draft={draft} onChange={(next) => edit(next)} />
          </BuiCard>
          <BuiCard className="flex flex-col gap-3 p-4">
            <h2 className="text-[13px] text-[#A6A6AD]">Project</h2>
            <BrandFields draft={draft} onChange={(next) => edit(next)} />
            <Field label="How posts identify you">
              <select
                aria-label="How posts identify you"
                className={inputClass}
                value={draft.disclosureMode}
                onChange={(event) =>
                  edit({
                    ...draft,
                    disclosureMode: event.target.value as WizardDraft["disclosureMode"],
                  })
                }
              >
                <option value="undisclosed_persona">
                  {disclosureLabel("undisclosed_persona")}
                </option>
                <option value="disclosed_persona">{disclosureLabel("disclosed_persona")}</option>
                <option value="disclosed_brand">{disclosureLabel("disclosed_brand")}</option>
                <option value="drafts_only">{disclosureLabel("drafts_only")}</option>
              </select>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Links">
                <input
                  aria-label="Links"
                  className={inputClass}
                  value={draft.links}
                  onChange={(event) => edit({ ...draft, links: event.target.value })}
                />
              </Field>
              <Field label="Posts">
                <input
                  aria-label="Posts"
                  className={inputClass}
                  value={draft.posts}
                  onChange={(event) => edit({ ...draft, posts: event.target.value })}
                />
              </Field>
            </div>
            <Field label="Forums to skip">
              <input
                aria-label="Forums to skip"
                className={inputClass}
                value={draft.denyHosts}
                onChange={(event) => edit({ ...draft, denyHosts: event.target.value })}
              />
            </Field>
            <div className="text-[13px] text-[#A6A6AD]">
              Countries {draft.markets.map((market) => market.country).join(", ") || "none"}
            </div>
          </BuiCard>
          {issues.length > 0 ? (
            <ul className="flex flex-col gap-1 text-[13px] text-[#FF8B8B]" role="alert">
              {issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          ) : null}
          <div className="flex items-center gap-3">
            <BuiButton
              tone="accent"
              label="Save settings"
              disabled={busy}
              onClick={() => void save()}
            >
              Save
            </BuiButton>
            {saved ? <SuccessPop label="Saved" /> : null}
          </div>
        </>
      ) : null}
      <BuiCard className="flex flex-col gap-2 p-4 text-[13px] text-[#C9C9CE]">
        <div>Proxy {(project.proxyPolicy ?? "").replaceAll("_", " ")}</div>
        <ul aria-label="Proxy leases" className="flex flex-col gap-1">
          {leases.length === 0 ? <li>No active lease</li> : null}
          {leases.map((lease) => (
            <li key={lease.id}>
              {lease.country} · {lease.kind.replaceAll("_", " ")} ·{" "}
              {lease.expiresAt ? lease.expiresAt.slice(0, 16) : "open"}
              {isSetupPlaceholder(lease.providerId) ? "" : ` · ${lease.providerId}`}
            </li>
          ))}
        </ul>
      </BuiCard>
    </section>
  );
}

function ScheduleFields({
  draft,
  onChange,
}: {
  draft: WizardDraft;
  onChange: (draft: WizardDraft) => void;
}) {
  return (
    <>
      <Field label="Days">
        <select
          aria-label="Days"
          className={inputClass}
          value={draft.weekdaysOnly ? "weekdays" : "every day"}
          onChange={(event) =>
            onChange({ ...draft, weekdaysOnly: event.target.value === "weekdays" })
          }
        >
          <option value="weekdays">Weekdays</option>
          <option value="every day">Every day</option>
        </select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Window start">
          <input
            aria-label="Window start"
            className={inputClass}
            value={draft.windowStart}
            onChange={(event) => onChange({ ...draft, windowStart: event.target.value })}
          />
        </Field>
        <Field label="Window end">
          <input
            aria-label="Window end"
            className={inputClass}
            value={draft.windowEnd}
            onChange={(event) => onChange({ ...draft, windowEnd: event.target.value })}
          />
        </Field>
      </div>
    </>
  );
}

function BrandFields({
  draft,
  onChange,
}: {
  draft: WizardDraft;
  onChange: (draft: WizardDraft) => void;
}) {
  return (
    <>
      <Field label="Project name">
        <input
          aria-label="Project name"
          className={inputClass}
          value={draft.name}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
        />
      </Field>
      <Field label="Brand name">
        <input
          aria-label="Brand name"
          className={inputClass}
          value={draft.brandName}
          onChange={(event) => onChange({ ...draft, brandName: event.target.value })}
        />
      </Field>
      <Field label="Sites posts may link to">
        <input
          aria-label="Sites posts may link to"
          className={inputClass}
          value={draft.allowedDomains}
          placeholder="https://www.example.com/de"
          onChange={(event) => onChange({ ...draft, allowedDomains: event.target.value })}
        />
        <p className="mt-1 text-[12px] text-[#85858A]">
          A domain, www, https, or a path. Separate several sites with a comma.
        </p>
      </Field>
    </>
  );
}

function PersonaFields({
  draft,
  onChange,
  showMail = true,
}: {
  draft: WizardDraft;
  onChange: (draft: WizardDraft) => void;
  showMail?: boolean;
}) {
  return (
    <>
      <Field label="Name on forums">
        <input
          aria-label="Name on forums"
          className={inputClass}
          value={draft.displayName}
          onChange={(event) => onChange({ ...draft, displayName: event.target.value })}
        />
      </Field>
      <Field label="Bio on forums">
        <textarea
          aria-label="Bio on forums"
          className={`${inputClass} min-h-20`}
          value={draft.bio}
          onChange={(event) => onChange({ ...draft, bio: event.target.value })}
        />
      </Field>
      {draft.markets[0]?.language === "de" ? (
        <Field label="Address people as">
          <select
            aria-label="Address people as"
            className={inputClass}
            value={draft.register}
            onChange={(event) =>
              onChange({ ...draft, register: event.target.value as "du" | "sie" })
            }
          >
            <option value="du">du, informal</option>
            <option value="sie">sie, formal</option>
          </select>
        </Field>
      ) : null}
      {showMail && draft.mailboxAddress && !isSetupPlaceholder(draft.mailboxAddress) ? (
        <div className="text-[13px] text-[#A6A6AD]">
          Forum mail arrives at {draft.mailboxAddress}
        </div>
      ) : null}
    </>
  );
}

function QuotaFields({
  draft,
  onChange,
  showAccounts = true,
}: {
  draft: WizardDraft;
  onChange: (draft: WizardDraft) => void;
  /** Setup asks for links. Account openings stay on the settings page. */
  showAccounts?: boolean;
}) {
  return (
    <>
      <div className="flex flex-col gap-3">
        {showAccounts ? (
          <Field label={QUOTA_LABELS.newPerDay}>
            <input
              aria-label={QUOTA_LABELS.newPerDay}
              className={inputClass}
              value={draft.newPerDay}
              onChange={(event) => onChange({ ...draft, newPerDay: event.target.value })}
            />
          </Field>
        ) : null}
        <Field label={QUOTA_LABELS.livePerDay}>
          <input
            aria-label={QUOTA_LABELS.livePerDay}
            className={inputClass}
            value={draft.livePerDay}
            onChange={(event) => onChange({ ...draft, livePerDay: event.target.value })}
          />
        </Field>
        <Field label={QUOTA_LABELS.liveWeek}>
          <input
            aria-label={QUOTA_LABELS.liveWeek}
            className={inputClass}
            value={draft.liveWeekCap}
            onChange={(event) => onChange({ ...draft, liveWeekCap: event.target.value })}
          />
        </Field>
      </div>
      <Field label="Time zone for posting">
        <input
          aria-label="Time zone for posting"
          className={inputClass}
          value={draft.timezone}
          onChange={(event) => onChange({ ...draft, timezone: event.target.value })}
        />
      </Field>
      <p className="text-[13px] text-[#A6A6AD]">{warmupNote(24)}</p>
    </>
  );
}

function TopicFields({
  draft,
  onChange,
  onSuggestPage,
}: {
  draft: WizardDraft;
  onChange: (next: WizardDraft | ((current: WizardDraft) => WizardDraft)) => void;
  onSuggestPage?: (input: {
    url: string;
    allowedDomains: string[];
  }) => Promise<{ keyword: string; rule: string }>;
}) {
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const asked = useRef(new Set<string>());
  const pending = draft.pages
    .map((page) => {
      const url = normalizePageUrl(page.url);
      if (!url || (page.keyword.trim() && page.rules.trim())) return "";
      return `${page.id}:${url}`;
    })
    .filter(Boolean)
    .join("|");
  useEffect(() => {
    if (!onSuggestPage || !pending) return;
    const domains = pageDomains(draftRef.current);
    for (const page of draftRef.current.pages) {
      const url = normalizePageUrl(page.url);
      if (!url || asked.current.has(url)) continue;
      if (page.keyword.trim() && page.rules.trim()) continue;
      asked.current.add(url);
      void onSuggestPage({ url, allowedDomains: domains }).then((suggestion) => {
        onChange((current) => ({
          ...current,
          pages: current.pages.map((item) => {
            if (item.id !== page.id || normalizePageUrl(item.url) !== url) return item;
            return {
              ...item,
              keyword: item.keyword.trim() ? item.keyword : suggestion.keyword,
              rules: item.rules.trim() ? item.rules : suggestion.rule,
            };
          }),
        }));
      });
    }
  }, [pending, onChange, onSuggestPage]);
  const atLimit = draft.pages.length >= PAGE_BOX_LIMIT;
  return (
    <div className="flex flex-col gap-3">
      {draft.pages.map((page, index) => (
        <BuiCard key={page.id} className="flex flex-col gap-3 p-4">
          {draft.pages.length > 1 ? (
            <div className="flex justify-end">
              <button
                type="button"
                aria-label={`Remove page ${index + 1}`}
                className="text-[13px] text-[#A6A6AD]"
                onClick={() => onChange(removeWizardPage(draft, index))}
              >
                Remove
              </button>
            </div>
          ) : null}
          <Field label="Page">
            <input
              aria-label={`Page ${index + 1}`}
              className={inputClass}
              inputMode="url"
              value={page.url}
              onChange={(event) => onChange(updatePage(draft, index, { url: event.target.value }))}
            />
          </Field>
          <Field label="Keyword">
            <input
              aria-label={`Keyword ${index + 1}`}
              className={inputClass}
              value={page.keyword}
              maxLength={80}
              onChange={(event) =>
                onChange(updatePage(draft, index, { keyword: event.target.value }))
              }
            />
          </Field>
          <Field label="Rules">
            <textarea
              aria-label={`Rules ${index + 1}`}
              className={`${inputClass} min-h-20`}
              value={page.rules}
              maxLength={500}
              onChange={(event) =>
                onChange(updatePage(draft, index, { rules: event.target.value }))
              }
            />
          </Field>
        </BuiCard>
      ))}
      <button
        type="button"
        aria-label="Add a page"
        disabled={atLimit}
        className="h-10 rounded-xl border border-[#2A2A31] text-[18px] text-[#ECECEE] disabled:cursor-not-allowed disabled:text-[#4A4A50]"
        onClick={() => onChange(addWizardPage(draft))}
      >
        +
      </button>
    </div>
  );
}

function updatePage(
  draft: WizardDraft,
  index: number,
  patch: Partial<Pick<WizardDraft["pages"][number], "url" | "keyword" | "rules">>,
): WizardDraft {
  return {
    ...draft,
    pages: draft.pages.map((page, item) => (item === index ? { ...page, ...patch } : page)),
  };
}

function ReviewFields({ draft }: { draft: WizardDraft }) {
  return (
    <dl className="flex flex-col gap-2 text-[13px]">
      {(
        [
          ["Brand name", draft.brandName],
          ["Sites", draft.allowedDomains || "—"],
          ["Countries", draft.markets.map((market) => market.country).join(", ")],
          ["Name on forums", draft.displayName || "—"],
          ...draft.pages
            .filter((page) => page.url.trim() || page.keyword.trim())
            .flatMap((page, index) => [
              [`Page ${index + 1}`, page.url || "—"],
              [`Keyword ${index + 1}`, page.keyword || "—"],
              [`Rules ${index + 1}`, page.rules || "—"],
            ]),
          [QUOTA_LABELS.livePerDay, draft.livePerDay],
          [QUOTA_LABELS.liveWeek, draft.liveWeekCap || "—"],
          ["How posts identify you", disclosureLabel(draft.disclosureMode)],
        ] as const
      ).map(([label, value]) => (
        <div key={label}>
          <dt className="text-[#85858A]">{label}</dt>
          <dd className="text-[#C9C9CE]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="block text-[12.5px] text-[#A6A6AD]">
      <span>{label}</span>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function CreditBudget({
  balance,
  note,
  busy,
  onBuy,
}: {
  balance: number | null;
  note?: string | null;
  busy: boolean;
  onBuy?: () => void;
}) {
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="text-[13px] text-[#ECECEE]">
        <span className="tabular-nums">{balance ?? "—"}</span>
        <span className="text-[#A6A6AD]"> credits</span>
      </div>
      <BuiButton label="Add credits" onClick={onBuy} disabled={busy || !onBuy}>
        Add credits
      </BuiButton>
      {note ? <p className="max-w-56 text-right text-[12px] text-[#A6A6AD]">{note}</p> : null}
    </div>
  );
}

function Pill({ label }: { label: string }) {
  return (
    <span className="rounded-full bg-[#232327] px-2 py-1 text-[12px] text-[#ECECEE]">{label}</span>
  );
}
