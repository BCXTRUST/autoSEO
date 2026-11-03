import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Copy,
  ExternalLink,
  FileText,
  Pause,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { BuiCard, LoadingState } from "../../components/beautiful-ui/primitives";
import {
  type CatalogPage,
  type CatalogProgress,
  hasCatalogJobsForWebsite,
  isExpectedCatalogAbsence,
  readCatalogPage,
  summarizeCatalog,
} from "../../lib/campaign-catalog";
import { campaignStartBlocked } from "../../lib/campaign-controls";
import { useCampaignDetail } from "../../lib/campaign-data";
import {
  canDismissDiscoveryRecord,
  canSelectDiscoveryRecord,
  countCandidatesForSearch,
  type DiscoveryRecord,
  summarizeDiscovery,
} from "../../lib/campaign-discovery";
import { readDraftProjectContext } from "../../lib/campaign-draft-context";
import { type CampaignRecoveryAction, campaignRecoveryActions } from "../../lib/campaign-recovery";
import type {
  CampaignConfig,
  CampaignItem,
  CampaignJob,
  CampaignMode,
  CampaignPublicationAction,
} from "../../lib/campaign-types";
import { useCampaignDialog } from "./use-campaign-dialog";
import "./campaigns.css";

type Tab = "Overview" | "Catalog" | "Opportunities" | "Accounts" | "Review" | "Results";
const statusNames: Record<string, string> = {
  queued: "Queued",
  running: "In progress",
  waiting_external: "Waiting",
  waiting_review: "Needs review",
  deferred: "Deferred",
  needs_action: "Needs action",
  reconciling: "Checking status",
  succeeded: "Complete",
  failed: "Error",
  cancelled: "Stopped",
  approved: "Approved",
  rejected: "Rejected",
  ready: "Needs review",
  researching: "Researching",
  submitted: "Submitted",
  verified: "Verified",
};
function relative(date: string) {
  const timestamp = Date.parse(date);
  if (!Number.isFinite(timestamp)) return "Time unavailable";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(timestamp);
}
function challengePollReady(nextPollAt: string | null) {
  return !nextPollAt || Date.parse(nextPollAt) <= Date.now();
}
function challengePollWait(nextPollAt: string) {
  const seconds = Math.max(0, Math.ceil((Date.parse(nextPollAt) - Date.now()) / 1_000));
  return seconds < 60 ? `${seconds}s` : `${Math.ceil(seconds / 60)}m`;
}
function publicationNextCheck(nextVerifyAt: string | null) {
  if (!nextVerifyAt) return "scheduled by the service";
  const remaining = Date.parse(nextVerifyAt) - Date.now();
  if (remaining <= 0) return "due now";
  const seconds = Math.ceil(remaining / 1_000);
  return seconds < 60 ? `in ${seconds}s` : `in ${Math.ceil(seconds / 60)}m`;
}
function discoveryErrorMessage(code: string | null | undefined) {
  switch (code) {
    case "robots_disallowed":
      return "This site’s crawl rules do not allow this page.";
    case "page_forbidden":
      return "The site refused access to this page.";
    case "search_unavailable":
    case "search_provider_unavailable":
      return "Community search is unavailable. Check the connection settings.";
    case "search_timeout":
    case "fetch_timeout":
      return "The request timed out. Retry when ready.";
    case "website_changed_uncertain_model_result":
    case "ai_result_ambiguous":
      return "A model result may be uncertain. Resolve the existing draft manually before any retry.";
    default:
      return code ? "This step needs attention; review activity before retrying." : null;
  }
}
export function CampaignDetail() {
  const { campaignId = "" } = useParams();
  const {
    snapshot,
    loading,
    stale,
    error,
    challengeStatus,
    challengeError,
    publicationStatus,
    publicationError,
    publicationActions,
    publicationActionsError,
    refreshPublicationStatus,
    refreshPublicationActions,
    publishDraft,
    verifyPublication,
    refresh,
    loadMore,
    control,
    stopAll,
    pollChallenge,
    updateConfig,
    addItem,
    recoverItem,
    reviewOpportunity,
    review,
    updateDraft,
    challengeResult,
  } = useCampaignDetail(campaignId);
  const [tab, setTab] = useState<Tab>("Overview");
  const [expanded, setExpanded] = useState(true);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceTitle, setSourceTitle] = useState("");
  const [working, setWorking] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [configOpen, setConfigOpen] = useState(false);
  const [configDraft, setConfigDraft] = useState<CampaignConfig | null>(null);
  const [revealedSolutions, setRevealedSolutions] = useState<Record<string, string>>({});
  const [copiedTaskId, setCopiedTaskId] = useState<string | null>(null);
  const [stopConfirm, setStopConfirm] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const [stopNotice, setStopNotice] = useState<string | null>(null);
  const [topicId, setTopicId] = useState("");
  const [publishConfirm, setPublishConfirm] = useState<{
    item: CampaignItem;
    topicId: number;
  } | null>(null);
  const [publishAuthorized, setPublishAuthorized] = useState(false);
  const configDialogRef = useCampaignDialog(
    configOpen,
    () => setConfigOpen(false),
    working === null,
  );
  const pauseDialogRef = useCampaignDialog(stopConfirm, () => setStopConfirm(false), !stopPending);
  const publishDialogRef = useCampaignDialog(
    Boolean(publishConfirm),
    () => setPublishConfirm(null),
    working === null,
  );
  const campaign = snapshot?.campaign;
  const jobs = snapshot?.jobs ?? [];
  const items = snapshot?.items ?? [];
  const activities = snapshot?.activities ?? [];
  const activeJobs = jobs.filter((job) =>
    ["running", "reconciling", "waiting_external"].includes(job.status),
  );
  const queued = jobs.filter((job) => job.status === "queued").length;
  const deferred = jobs.filter((job) => job.status === "deferred").length;
  const catalogProgress = useMemo(
    () => summarizeCatalog(items, jobs, campaign?.config.websiteUrl),
    [items, jobs, campaign?.config.websiteUrl],
  );
  const discoverySummary = useMemo(() => summarizeDiscovery(items, jobs), [items, jobs]);
  const discoveryItemIds = useMemo(
    () =>
      new Set([
        ...discoverySummary.searches.map((record) => record.item.id),
        ...discoverySummary.candidates.map((record) => record.item.id),
      ]),
    [discoverySummary],
  );
  const catalogItemsById = new Map(catalogProgress.pages.map((page) => [page.item.id, page.item]));
  const expectedCatalogAbsenceItems = new Set(
    jobs
      .filter((job) =>
        isExpectedCatalogAbsence(job.itemId ? catalogItemsById.get(job.itemId) : undefined, job),
      )
      .map((job) => job.itemId)
      .filter(Boolean),
  );
  const jobActionItems = new Set(
    jobs
      .filter(
        (job) =>
          ["needs_action", "failed"].includes(job.status) &&
          !isExpectedCatalogAbsence(job.itemId ? catalogItemsById.get(job.itemId) : undefined, job),
      )
      .map((job) => job.itemId)
      .filter(Boolean),
  );
  const needsAction =
    jobs.filter(
      (job) =>
        ["needs_action", "failed"].includes(job.status) &&
        !isExpectedCatalogAbsence(job.itemId ? catalogItemsById.get(job.itemId) : undefined, job),
    ).length +
    items.filter(
      (item) =>
        item.status === "needs_action" &&
        !jobActionItems.has(item.id) &&
        !expectedCatalogAbsenceItems.has(item.id),
    ).length;
  const latest = activities.at(-1);
  const currentJob =
    activeJobs[0] ??
    jobs.find((job) =>
      ["queued", "deferred", "needs_action", "waiting_review"].includes(job.status),
    );
  const currentItem = currentJob?.itemId
    ? items.find((item) => item.id === currentJob.itemId)
    : undefined;
  const erroredJobs = jobs.filter((job) => job.lastError);
  const catalogBatchFinished =
    campaign?.mode === "research" &&
    hasCatalogJobsForWebsite(items, catalogProgress.jobs, campaign?.config.websiteUrl) &&
    activeJobs.length === 0 &&
    queued === 0 &&
    deferred === 0 &&
    needsAction === 0;
  const nextAction =
    needsAction > 0
      ? "Review items needing action"
      : queued > 0
        ? "Queued work will continue when the campaign is active"
        : deferred > 0
          ? "Deferred work is waiting for its next eligible window"
          : campaign?.mode === "controlled"
            ? "Add a test URL to begin controlled research"
            : catalogBatchFinished
              ? "Review the official website catalog and observed pages"
              : campaign?.status === "draft"
                ? "Start campaign to catalog your configured website"
                : "Review the official website catalog or add a public URL";
  const reviewItems = useMemo(() => items.filter((item) => item.kind === "draft"), [items]);
  const pendingReviewCount = reviewItems.filter((item) =>
    ["ready", "needs_action"].includes(item.status),
  ).length;
  const catalogItemIds = useMemo(
    () => new Set(catalogProgress.pages.map((page) => page.item.id)),
    [catalogProgress.pages],
  );
  const opportunityItems = useMemo(
    () =>
      items.filter(
        (item) =>
          (item.kind === "opportunity" || item.kind === "source") &&
          !catalogItemIds.has(item.id) &&
          !discoveryItemIds.has(item.id),
      ),
    [items, catalogItemIds, discoveryItemIds],
  );
  const accountItems = useMemo(() => items.filter((item) => item.kind === "account"), [items]);
  const approvedDrafts = reviewItems.filter((item) => item.status === "approved");
  const controlledStartDisabled = campaign
    ? campaignStartBlocked(campaign, opportunityItems)
    : false;
  const completedResults = items.filter(
    (item) =>
      !catalogItemIds.has(item.id) &&
      !discoveryItemIds.has(item.id) &&
      (["verified", "approved", "submitted"].includes(item.status) || item.kind === "publication"),
  );

  async function run(key: string, action: () => Promise<unknown>) {
    setWorking(key);
    setActionError(null);
    try {
      await action();
    } catch (cause) {
      setActionError(
        cause instanceof Error ? cause.message : "Action failed. The campaign was refreshed.",
      );
    } finally {
      setWorking(null);
    }
  }
  async function submitSource(event: FormEvent) {
    event.preventDefault();
    await run("source", async () => {
      await addItem({
        kind: "source",
        url: sourceUrl,
        title: sourceTitle || sourceUrl,
      });
      setSourceUrl("");
      setSourceTitle("");
      setSourceOpen(false);
    });
  }
  function recover(item: CampaignItem, action: "retry" | "defer" | "skip") {
    const isCatalogGuidance =
      readCatalogPage(item)?.metadata.purpose === "guidance" &&
      jobs.some((job) => job.itemId === item.id && job.operation === "catalog_page");
    if (
      action === "skip" &&
      !window.confirm(
        isCatalogGuidance
          ? `Skip “${item.title}”? Website catalog crawling will be blocked and no pages will be fetched.`
          : `Skip “${item.title}”? This will mark the item failed.`,
      )
    )
      return;
    void run(`recover-${item.id}`, () => recoverItem(item, action));
  }
  function decideDiscovery(item: CampaignItem, action: "select" | "dismiss") {
    void run(`discovery-${action}-${item.id}`, () => reviewOpportunity(item, action));
  }
  async function pauseAll() {
    setStopPending(true);
    setActionError(null);
    try {
      const result = await stopAll();
      setStopNotice(
        `Paused ${result.pausedCount} active campaign${result.pausedCount === 1 ? "" : "s"}.`,
      );
      setStopConfirm(false);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not pause campaigns");
    } finally {
      setStopPending(false);
    }
  }
  if (loading && !snapshot)
    return (
      <div className="campaign-load-screen">
        <LoadingState label="Loading campaign" />
      </div>
    );
  if (!campaign)
    return (
      <div className="campaign-load-screen">
        <div className="campaign-load-error">
          <TriangleAlert size={20} />
          <h2>Campaign unavailable</h2>
          <p>{error ?? "This campaign could not be loaded."}</p>
          <button className="campaign-primary-button" onClick={() => void refresh()} type="button">
            Retry
          </button>
          <Link to="/app">Back to campaigns</Link>
        </div>
      </div>
    );

  return (
    <div className="campaign-app">
      <aside className="campaign-sidebar">
        <Link className="campaign-brand" to="/app">
          <span className="campaign-brand-mark">
            <Activity size={17} />
          </span>
          <span>AutoSEO</span>
          <span className="campaign-brand-dot" />
        </Link>
        <div className="campaign-nav-label">CAMPAIGN</div>
        <Link className="campaign-nav-item" to="/app">
          <ArrowLeft size={16} /> All campaigns
        </Link>
        <div className="campaign-side-current">
          <span className="campaign-status-dot" />
          <span>{campaign.config.name}</span>
        </div>
        <div className="campaign-sidebar-spacer" />
        <div className="campaign-sidebar-note">
          <ShieldCheck size={16} />
          <span>Publication always requires your review.</span>
        </div>
        <a className="campaign-legacy-link" href="/app/agents">
          Open agent workspace <ArrowUpRight size={14} />
        </a>
      </aside>

      <main className="campaign-main campaign-detail-main">
        <header className="campaign-topbar">
          <div>
            <Link to="/app" className="campaign-crumb-link">
              Campaigns
            </Link>
            <span className="campaign-crumb-sep">/</span>
            <strong>{campaign.config.name}</strong>
          </div>
          <div className="campaign-topbar-right">
            <span className={`campaign-status ${campaign.status}`}>
              <i />
              {campaign.status}
            </span>
          </div>
        </header>
        <div className="campaign-content campaign-detail-content">
          <div className="campaign-detail-title-row">
            <div>
              <div className="campaign-eyebrow">
                CAMPAIGN CONTROL <span>·</span> REVISION {campaign.revision}
              </div>
              <h1>{campaign.config.name}</h1>
              <a
                className="campaign-site-link"
                href={campaign.config.websiteUrl}
                target="_blank"
                rel="noreferrer"
              >
                {campaign.config.websiteUrl}
                <ExternalLink size={13} />
              </a>
            </div>
            <div className="campaign-control-buttons">
              <button
                className="campaign-secondary-button"
                disabled={working !== null}
                onClick={() => {
                  setConfigDraft(campaign.config);
                  setConfigOpen(true);
                }}
                type="button"
              >
                Edit setup
              </button>
              {campaign.status === "active" ? (
                <button
                  className="campaign-secondary-button"
                  disabled={working !== null}
                  onClick={() => void run("control", () => control("pause"))}
                  type="button"
                >
                  <Pause size={15} /> Pause
                </button>
              ) : (
                campaign.status !== "archived" && (
                  <button
                    className="campaign-primary-button"
                    disabled={working !== null || controlledStartDisabled}
                    onClick={() =>
                      void run("control", () =>
                        control(campaign.status === "paused" ? "resume" : "start"),
                      )
                    }
                    type="button"
                  >
                    <Play size={15} /> {campaign.status === "paused" ? "Resume" : "Start campaign"}
                  </button>
                )
              )}
              <button
                className="campaign-secondary-button pause-all-button"
                disabled={working !== null}
                onClick={() => setStopConfirm(true)}
                type="button"
              >
                Pause all
              </button>
              <button
                className="campaign-icon-button"
                aria-label="Refresh campaign"
                onClick={() => void refresh()}
                type="button"
              >
                <RefreshCw size={15} />
              </button>
            </div>
          </div>
          {campaign.mode === "controlled" && (
            <div className="campaign-test-banner">
              <TriangleAlert size={15} />
              <span>
                <strong>Controlled test</strong> — fixture outcomes are test-only and do not
                represent live registrations or publications.
              </span>
            </div>
          )}
          {stale && (
            <div className="campaign-stale-banner" role="status">
              <span>
                <i /> Connection interrupted · showing the last saved snapshot
              </span>
              <button onClick={() => void refresh()} type="button">
                Retry
              </button>
            </div>
          )}
          {actionError && (
            <div className="campaign-inline-alert" role="alert">
              <span>{actionError}</span>
              <button onClick={() => void refresh()} type="button">
                Refresh
              </button>
            </div>
          )}
          {stopNotice && (
            <div className="campaign-inline-success" role="status">
              <ShieldCheck size={14} />
              {stopNotice}
              <button
                onClick={() => setStopNotice(null)}
                aria-label="Dismiss pause confirmation"
                type="button"
              >
                ×
              </button>
            </div>
          )}

          <section className="campaign-activity-summary">
            <BuiCard className="campaign-live-card">
              <div className="campaign-live-head">
                <div>
                  <span className="campaign-eyebrow">CURRENT TASK</span>
                  <span className={`campaign-status task-${currentJob?.status ?? "idle"}`}>
                    <i />
                    {currentJob
                      ? (statusNames[currentJob.status] ?? currentJob.status)
                      : "No task running"}
                  </span>
                </div>
                <span className={`campaign-mode ${campaign.mode}`}>
                  {campaign.mode === "controlled" ? "Controlled test" : "Research mode"}
                </span>
              </div>
              <h2>
                {currentItem?.title ??
                  currentJob?.operation ??
                  (catalogBatchFinished ? "Catalog batch finished" : "Ready for research")}
              </h2>
              <p>
                {currentItem?.url ??
                  (currentJob
                    ? `Operation: ${currentJob.operation}`
                    : catalogBatchFinished
                      ? "The bounded catalog batch has no queued work. Review fetched pages and retry optional missing pages if useful."
                      : campaign.mode === "research"
                        ? "Start the campaign to catalog its configured website, or add an optional public URL."
                        : "Add a public URL to run the controlled test fixture.")}
              </p>
              <div className="campaign-task-meta">
                <span>
                  <Clock3 size={14} />{" "}
                  {latest ? `Progress ${relative(latest.occurredAt)}` : "No progress recorded yet"}
                </span>
                {currentJob && (
                  <span>
                    Attempt {currentJob.attemptCount} of {currentJob.maxAttempts}
                  </span>
                )}
              </div>
            </BuiCard>
            <BuiCard className="campaign-next-card">
              <div className="campaign-next-icon">
                <ArrowUpRight size={17} />
              </div>
              <div className="campaign-eyebrow">NEXT ACTION</div>
              <h3>{nextAction}</h3>
              <p>
                {needsAction
                  ? `${needsAction} item${needsAction === 1 ? "" : "s"} need attention.`
                  : queued
                    ? `${queued} queued · ${deferred} deferred`
                    : campaign.mode === "research"
                      ? "Research mode starts at zero spend."
                      : "Controlled test fixture only."}
              </p>
              <div className="campaign-queue-row">
                <span>
                  <b>{queued}</b> queued
                </span>
                <span>
                  <b>{deferred}</b> deferred
                </span>
                <span>
                  <b>{needsAction}</b> needs action
                </span>
              </div>
            </BuiCard>
          </section>

          <nav className="campaign-tabs" aria-label="Campaign sections">
            {(
              ["Overview", "Catalog", "Opportunities", "Accounts", "Review", "Results"] as Tab[]
            ).map((name) => (
              <button
                key={name}
                className={tab === name ? "selected" : ""}
                onClick={() => setTab(name)}
                type="button"
              >
                {name}
                {name === "Catalog" && catalogProgress.pages.length > 0 && (
                  <span className="campaign-tab-count">{catalogProgress.pages.length}</span>
                )}
                {name === "Review" && pendingReviewCount > 0 && (
                  <span className="campaign-tab-count">{pendingReviewCount}</span>
                )}
              </button>
            ))}
          </nav>
          <div className="campaign-detail-grid">
            <section className="campaign-panel-column">
              {tab === "Overview" && (
                <>
                  <BuiCard className="campaign-panel">
                    <div className="campaign-panel-heading">
                      <div>
                        <h2>Campaign overview</h2>
                        <p>Live state from the campaign service</p>
                      </div>
                      <span className={`campaign-status ${campaign.status}`}>
                        <i />
                        {campaign.status}
                      </span>
                    </div>
                    <div className="campaign-overview-stats">
                      <div>
                        <span>Queued</span>
                        <b>{queued}</b>
                      </div>
                      <div>
                        <span>Deferred</span>
                        <b>{deferred}</b>
                      </div>
                      <div>
                        <span>Needs action</span>
                        <b>{needsAction}</b>
                      </div>
                      <div>
                        <span>Attempts</span>
                        <b>{jobs.reduce((total, job) => total + job.attemptCount, 0)}</b>
                      </div>
                    </div>
                    <div className="campaign-config-grid">
                      <div>
                        <span>Market</span>
                        <b>{campaign.config.market}</b>
                      </div>
                      <div>
                        <span>Language</span>
                        <b>{campaign.config.language}</b>
                      </div>
                      <div>
                        <span>Daily registration limit</span>
                        <b>{campaign.config.dailyRegistrationLimit}</b>
                      </div>
                      <div>
                        <span>Daily publication limit</span>
                        <b>{campaign.config.dailyPublicationLimit}</b>
                      </div>
                      <div>
                        <span>Daily spend limit</span>
                        <b>
                          {campaign.config.dailySpendLimitMicros === 0
                            ? "$0 · disabled"
                            : `$${(campaign.config.dailySpendLimitMicros / 1_000_000).toFixed(2)}`}
                        </b>
                      </div>
                      <div>
                        <span>Publication review</span>
                        <b>
                          <ShieldCheck size={14} /> Required
                        </b>
                      </div>
                    </div>
                  </BuiCard>
                  <BuiCard className="campaign-panel challenge-status-panel">
                    <div className="campaign-panel-heading">
                      <div>
                        <h2>AntiCaptcha · image challenges</h2>
                        <p>Separate service status · image-to-text only</p>
                      </div>
                      <span className={`challenge-state ${challengeStatus?.status ?? "loading"}`}>
                        {challengeStatus?.status.replaceAll("_", " ") ??
                          (challengeError ? "unavailable" : "checking")}
                      </span>
                    </div>
                    {challengeStatus ? (
                      <>
                        <div className="challenge-status-grid">
                          <div>
                            <span>Provider configured</span>
                            <b>{challengeStatus.configured ? "Yes" : "No"}</b>
                          </div>
                          <div>
                            <span>Paid tasks</span>
                            <b>{challengeStatus.paidTasksEnabled ? "Enabled" : "Disabled"}</b>
                          </div>
                          {challengeStatus.balanceUsd !== null && (
                            <div>
                              <span>Reported balance</span>
                              <b>${challengeStatus.balanceUsd.toFixed(2)}</b>
                            </div>
                          )}
                          <div>
                            <span>Task records</span>
                            <b>{challengeStatus.tasks.length}</b>
                          </div>
                        </div>
                        {challengeError && (
                          <p className="challenge-safe-error">
                            Status refresh failed; showing the last reported state.
                          </p>
                        )}
                        {challengeStatus.error && (
                          <p className="challenge-safe-error">{challengeStatus.error}</p>
                        )}
                        {challengeStatus.tasks.length > 0 && (
                          <div className="challenge-task-list">
                            {challengeStatus.tasks.slice(0, 4).map((task) => (
                              <div className="challenge-task-row" key={task.id}>
                                <span className={`challenge-state ${task.status}`}>
                                  {task.status}
                                </span>
                                <span>
                                  {task.pollAttempts}/{task.maxPollAttempts} checks
                                </span>
                                <span>
                                  {task.actualCostMicros === null
                                    ? `Reserved $${(task.reservationMicros / 1_000_000).toFixed(4)}`
                                    : `Cost $${(task.actualCostMicros / 1_000_000).toFixed(4)}`}
                                </span>
                                {task.safeError && (
                                  <small>{task.safeError.replaceAll("_", " ")}</small>
                                )}
                                {challengeStatus.status === "ready" &&
                                  challengeStatus.paidTasksEnabled &&
                                  task.status === "submitted" && (
                                    <button
                                      className="campaign-text-button"
                                      disabled={
                                        working !== null || !challengePollReady(task.nextPollAt)
                                      }
                                      onClick={() =>
                                        void run(`poll-${task.id}`, () => pollChallenge(task.id))
                                      }
                                      type="button"
                                    >
                                      {working === `poll-${task.id}`
                                        ? "Checking…"
                                        : challengePollReady(task.nextPollAt)
                                          ? "Check task"
                                          : `Available in ${challengePollWait(task.nextPollAt!)}`}
                                    </button>
                                  )}
                                {challengeStatus.status === "ready" &&
                                  challengeStatus.paidTasksEnabled &&
                                  task.status === "ready" &&
                                  !revealedSolutions[task.id] && (
                                    <button
                                      className="campaign-text-button"
                                      disabled={working !== null}
                                      onClick={() =>
                                        void run(`challenge-${task.id}`, async () => {
                                          const result = await challengeResult(task.id);
                                          if (result.application !== "manual_only")
                                            throw new Error(
                                              "This answer cannot be applied automatically.",
                                            );
                                          setRevealedSolutions((current) => ({
                                            ...current,
                                            [task.id]: result.solution,
                                          }));
                                        })
                                      }
                                      type="button"
                                    >
                                      {working === `challenge-${task.id}`
                                        ? "Loading answer…"
                                        : "Show answer"}
                                    </button>
                                  )}
                                {revealedSolutions[task.id] && (
                                  <div className="challenge-solution">
                                    <span>{revealedSolutions[task.id]}</span>
                                    <button
                                      className="campaign-secondary-button"
                                      onClick={() =>
                                        void navigator.clipboard
                                          .writeText(revealedSolutions[task.id]!)
                                          .then(() => setCopiedTaskId(task.id))
                                          .catch(() =>
                                            setActionError(
                                              "Clipboard access is unavailable; select and copy the answer.",
                                            ),
                                          )
                                      }
                                      type="button"
                                    >
                                      <Copy size={13} />
                                      {copiedTaskId === task.id ? "Copied" : "Copy answer"}
                                    </button>
                                    <small>Manual use only</small>
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="challenge-status-wait">
                        {challengeError
                          ? "Service status could not be loaded."
                          : "Checking configured service status…"}
                      </div>
                    )}
                    <div className="campaign-capability-note">
                      <CircleHelp size={14} />
                      <span>
                        Automatic challenge solving is not connected to this campaign yet.
                        Image-to-text only. Copy the answer into your authorized task.
                      </span>
                    </div>
                  </BuiCard>
                  <BuiCard className="campaign-panel">
                    <div className="campaign-panel-heading">
                      <div>
                        <h2>Work queue</h2>
                        <p>Attempts and wait states from the latest snapshot</p>
                      </div>
                    </div>
                    {jobs.length === 0 ? (
                      <div className="campaign-panel-empty">
                        <span className="campaign-empty-icon small">
                          <Activity size={18} />
                        </span>
                        <strong>No tasks yet</strong>
                        <span>
                          {campaign.mode === "research"
                            ? "Start the campaign to catalog its configured website. Add optional URLs in Opportunities."
                            : "Add a test URL in Opportunities to begin the controlled fixture."}
                        </span>
                      </div>
                    ) : (
                      <div className="campaign-job-list">
                        {jobs.map((job) => {
                          const item = items.find((value) => value.id === job.itemId);
                          return (
                            <div className="campaign-job-row" key={job.id}>
                              <span className={`job-indicator ${job.status}`} />
                              <div className="campaign-job-main">
                                <strong>{item?.title ?? job.operation}</strong>
                                <span>
                                  {job.operation}
                                  {item?.url ? ` · ${item.url}` : ""}
                                </span>
                              </div>
                              <span className={`campaign-status job-status-${job.status}`}>
                                {statusNames[job.status] ?? job.status}
                              </span>
                              <span className="campaign-attempt">
                                {job.attemptCount}/{job.maxAttempts}
                              </span>
                              {job.lastError && (
                                <p className="campaign-job-error">
                                  <TriangleAlert size={13} />
                                  {job.lastError}
                                </p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </BuiCard>
                </>
              )}
              {tab === "Catalog" && (
                <CatalogPanel
                  progress={catalogProgress}
                  jobs={jobs}
                  mode={campaign.mode}
                  websiteUrl={campaign.config.websiteUrl}
                  onRecover={recover}
                  working={working}
                />
              )}
              {tab === "Opportunities" && (
                <BuiCard className="campaign-panel">
                  <DiscoveryPanel
                    summary={discoverySummary}
                    jobs={jobs}
                    mode={campaign.mode}
                    websiteUrl={campaign.config.websiteUrl}
                    working={working}
                    onRecover={recover}
                    onReview={decideDiscovery}
                  />
                  <div className="campaign-panel-heading">
                    <div>
                      <h2>Manually added sources</h2>
                      <p>URLs you supplied separately from the official website catalog</p>
                    </div>
                    <button
                      className="campaign-primary-button compact"
                      onClick={() => setSourceOpen((value) => !value)}
                      type="button"
                    >
                      <Plus size={15} /> Add URL
                    </button>
                  </div>
                  {sourceOpen && (
                    <form
                      className="campaign-source-form"
                      onSubmit={(event) => void submitSource(event)}
                    >
                      <label>
                        Public page URL
                        <input
                          required
                          maxLength={2048}
                          type="url"
                          value={sourceUrl}
                          onChange={(event) => setSourceUrl(event.target.value)}
                          placeholder="https://example.com/resources"
                        />
                      </label>
                      <label>
                        Label
                        <input
                          maxLength={200}
                          value={sourceTitle}
                          onChange={(event) => setSourceTitle(event.target.value)}
                          placeholder="Optional page name"
                        />
                      </label>
                      <button
                        className="campaign-primary-button compact"
                        disabled={working !== null}
                        type="submit"
                      >
                        {working === "source" ? "Adding…" : "Add to research"}
                      </button>
                    </form>
                  )}
                  {opportunityItems.length ? (
                    <div className="campaign-content-list">
                      {opportunityItems.map((item) => (
                        <ContentItem
                          key={item.id}
                          item={item}
                          mode={campaign.mode}
                          jobs={jobs}
                          working={working !== null}
                          onRecover={(action) => recover(item, action)}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="campaign-panel-empty">
                      <span className="campaign-empty-icon small">
                        <ExternalLink size={18} />
                      </span>
                      <strong>No manually added sources yet</strong>
                      <span>
                        {campaign.mode === "research"
                          ? "The configured website is cataloged in the Catalog tab. Add public URLs here for focused research."
                          : "Add a public test URL to create controlled fixture outcomes."}
                      </span>
                      <button
                        className="campaign-text-button"
                        onClick={() => setSourceOpen(true)}
                        type="button"
                      >
                        Add a URL
                      </button>
                    </div>
                  )}
                  <div className="campaign-capability-note">
                    <CircleHelp size={14} />
                    <span>
                      User-added URLs remain separate from the official website catalog. Retry
                      respects ambiguous paid-work safeguards; Defer waits five minutes; Skip marks
                      the item failed. Account registration is not available.
                    </span>
                  </div>
                </BuiCard>
              )}
              {tab === "Accounts" && (
                <BuiCard className="campaign-panel">
                  <div className="campaign-panel-heading">
                    <div>
                      <h2>Account records</h2>
                      <p>Reported account state attached to this campaign</p>
                    </div>
                    <span className="campaign-status">
                      <i />
                      {accountItems.length} records
                    </span>
                  </div>
                  {accountItems.length ? (
                    <div className="campaign-content-list">
                      {accountItems.map((item) => (
                        <AccountItem key={item.id} item={item} mode={campaign.mode} />
                      ))}
                    </div>
                  ) : (
                    <div className="campaign-panel-empty">
                      <span className="campaign-empty-icon small">
                        <ShieldCheck size={18} />
                      </span>
                      <strong>No account records</strong>
                      <span>Live account registration is unavailable in this campaign flow.</span>
                    </div>
                  )}
                  <div className="campaign-capability-note">
                    <CircleHelp size={14} />
                    <span>
                      Controlled test accounts are local fixtures. No live account registration or
                      confirmation email is supported.
                    </span>
                  </div>
                </BuiCard>
              )}
              {tab === "Review" && (
                <BuiCard className="campaign-panel">
                  <div className="campaign-panel-heading">
                    <div>
                      <h2>Draft review</h2>
                      <p>Edits reset approval so you can review the latest version</p>
                    </div>
                    <span className="campaign-review-required">
                      <ShieldCheck size={14} /> Review required
                    </span>
                  </div>
                  {reviewItems.length ? (
                    <div className="campaign-content-list">
                      {reviewItems.map((item) => (
                        <DraftCard
                          key={item.id}
                          item={item}
                          websiteUrl={campaign.config.websiteUrl}
                          working={working !== null}
                          editing={editingId === item.id}
                          body={editingId === item.id ? editBody : item.body}
                          onEdit={() => {
                            setEditingId(item.id);
                            setEditBody(item.body);
                          }}
                          onBody={setEditBody}
                          onCancel={() => setEditingId(null)}
                          onSave={() =>
                            void run(`edit-${item.id}`, async () => {
                              await updateDraft(item, editBody);
                              setEditingId(null);
                            })
                          }
                          onReview={(decision) =>
                            void run(`${decision}-${item.id}`, () => review(item, decision))
                          }
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="campaign-panel-empty">
                      <span className="campaign-empty-icon small">
                        <FileText size={18} />
                      </span>
                      <strong>Nothing to review</strong>
                      <span>
                        Drafts prepared by research will appear here before any publication.
                      </span>
                    </div>
                  )}
                  <div className="campaign-capability-note">
                    <ShieldCheck size={14} />
                    <span>
                      Publication is separate from approval. A reviewed post can be submitted only
                      when the owner’s Discourse connection is ready, with a second explicit
                      confirmation.
                    </span>
                  </div>
                </BuiCard>
              )}
              {tab === "Results" && (
                <>
                  <BuiCard className="campaign-panel publication-panel">
                    <div className="campaign-panel-heading">
                      <div>
                        <h2>Discourse publication</h2>
                        <p>
                          Owner-authorized connection · each post requires explicit confirmation
                        </p>
                      </div>
                      <span className={`challenge-state ${publicationStatus?.status ?? "loading"}`}>
                        {publicationStatus?.status.replaceAll("_", " ") ??
                          (publicationError ? "unavailable" : "checking")}
                      </span>
                    </div>
                    <div className="publication-status-copy">
                      <strong>
                        {publicationStatus?.status === "ready"
                          ? "Connection is ready"
                          : publicationStatus?.status === "unavailable"
                            ? "Connection status unavailable"
                            : publicationStatus?.status === "not_configured"
                              ? "Not configured"
                              : publicationStatus?.status === "disabled"
                                ? "Publication disabled"
                                : publicationError
                                  ? "Status could not be loaded"
                                  : "Checking publication status…"}
                      </strong>
                      <span>
                        {publicationStatus?.error ??
                          publicationError ??
                          (publicationStatus?.status === "ready"
                            ? "Only an approved draft can be submitted. No post is sent until you confirm."
                            : "Discourse publication is not currently available for this campaign.")}
                      </span>
                      {publicationStatus?.account && (
                        <small>
                          Connected as {publicationStatus.account}
                          {publicationStatus.baseUrl ? ` · ${publicationStatus.baseUrl}` : ""}
                        </small>
                      )}
                    </div>
                    {publicationError && (
                      <div className="publication-inline-note" role="status">
                        Showing the last reported provider status.{" "}
                        <button
                          className="campaign-text-button"
                          onClick={() => void refreshPublicationStatus()}
                          type="button"
                        >
                          Retry status
                        </button>
                      </div>
                    )}
                    {publicationStatus?.status === "ready" && campaign.mode === "research" && (
                      <div className="publication-submit-row">
                        <label>
                          Discourse topic ID
                          <input
                            aria-label="Discourse topic ID"
                            inputMode="numeric"
                            pattern="[0-9]+"
                            value={topicId}
                            onChange={(event) => setTopicId(event.target.value)}
                            placeholder="Enter an existing topic ID"
                          />
                        </label>
                        <button
                          className="campaign-secondary-button"
                          onClick={() => void refreshPublicationStatus()}
                          disabled={working !== null}
                          type="button"
                        >
                          <RefreshCw size={13} /> Refresh status
                        </button>
                      </div>
                    )}
                    {approvedDrafts.length > 0 &&
                      publicationStatus?.status === "ready" &&
                      campaign.mode === "research" && (
                        <div className="publication-approved-list">
                          <h3>Approved drafts</h3>
                          {approvedDrafts.map((draft) => {
                            const existing = publicationActions.find(
                              (action) =>
                                action.draftId === draft.id &&
                                [
                                  "intent",
                                  "submitted",
                                  "pending",
                                  "ambiguous",
                                  "verified",
                                ].includes(action.status),
                            );
                            return (
                              <article className="publication-draft-row" key={draft.id}>
                                <div>
                                  <strong>{draft.title}</strong>
                                  <span>
                                    {existing
                                      ? `Publication ${existing.status} · resubmission is blocked`
                                      : `Reviewed ${relative(draft.updatedAt)}`}
                                  </span>
                                </div>
                                <button
                                  className="campaign-primary-button compact"
                                  disabled={
                                    working !== null ||
                                    Boolean(existing) ||
                                    !/^\d+$/.test(topicId) ||
                                    Number(topicId) < 1
                                  }
                                  onClick={() => {
                                    setPublishAuthorized(false);
                                    setPublishConfirm({
                                      item: draft,
                                      topicId: Number(topicId),
                                    });
                                  }}
                                  type="button"
                                >
                                  Review publish
                                </button>
                              </article>
                            );
                          })}
                        </div>
                      )}
                    <div className="publication-ledger">
                      <div className="publication-ledger-heading">
                        <h3>Publication ledger</h3>
                        <button
                          className="campaign-text-button"
                          onClick={() => void refreshPublicationActions()}
                          type="button"
                        >
                          Refresh ledger
                        </button>
                      </div>
                      {publicationActionsError && (
                        <p className="publication-inline-note" role="status">
                          Ledger refresh failed; showing the last saved actions.
                        </p>
                      )}
                      {publicationActions.length ? (
                        publicationActions.map((action) => (
                          <PublicationActionRow
                            key={action.id}
                            action={action}
                            working={working !== null}
                            onVerify={() =>
                              void run(`verify-${action.id}`, () => verifyPublication(action.id))
                            }
                          />
                        ))
                      ) : (
                        <p className="publication-empty">
                          No publication actions have been recorded.
                        </p>
                      )}
                    </div>
                    <div className="campaign-capability-note">
                      <ShieldCheck size={14} />
                      <span>
                        The service checks known Discourse receipts automatically. Use “Check now”
                        for a manual verification. An ambiguous submission is never resubmitted
                        automatically; inspect its ledger entry before taking action.
                      </span>
                    </div>
                  </BuiCard>
                  <BuiCard className="campaign-panel">
                    <div className="campaign-panel-heading">
                      <div>
                        <h2>Campaign results</h2>
                        <p>Completed work reported by the campaign service</p>
                      </div>
                    </div>
                    {completedResults.length ? (
                      <div className="campaign-content-list">
                        {completedResults.map((item) => (
                          <ContentItem key={item.id} item={item} />
                        ))}
                      </div>
                    ) : (
                      <div className="campaign-panel-empty">
                        <span className="campaign-empty-icon small">
                          <Check size={18} />
                        </span>
                        <strong>No completed results yet</strong>
                        <span>
                          Campaign outcomes will appear here when the service reports them.
                        </span>
                      </div>
                    )}
                  </BuiCard>
                </>
              )}
            </section>
            <aside className={`campaign-activity-rail ${expanded ? "expanded" : "collapsed"}`}>
              <div className="campaign-rail-heading">
                <div>
                  <span className="campaign-eyebrow">LIVE FEED</span>
                  <h2>Activity</h2>
                </div>
                <button
                  className="campaign-icon-button"
                  aria-label={expanded ? "Collapse activity" : "Expand activity"}
                  onClick={() => setExpanded((value) => !value)}
                  type="button"
                >
                  <ChevronDown size={15} />
                </button>
              </div>
              <div className="campaign-rail-summary">
                <span className="campaign-live-dot" />
                {stale ? "Reconnecting" : "Updating"}
                <span className="rail-updated">
                  {latest ? relative(latest.occurredAt) : "Waiting for first event"}
                </span>
              </div>
              {expanded && (
                <>
                  <div className="campaign-timeline">
                    {activities.length === 0 ? (
                      <div className="campaign-feed-empty">No activity has been recorded yet.</div>
                    ) : (
                      activities
                        .slice(-12)
                        .reverse()
                        .map((event) => (
                          <div className="campaign-event" key={event.id}>
                            <span className={`campaign-event-dot ${event.type}`} />
                            <div>
                              <p>{event.summary}</p>
                              <time dateTime={event.occurredAt}>{relative(event.occurredAt)}</time>
                            </div>
                          </div>
                        ))
                    )}
                  </div>
                  {snapshot?.hasMore && (
                    <button
                      className="campaign-load-more"
                      onClick={() => void loadMore()}
                      type="button"
                    >
                      Load more activity
                    </button>
                  )}
                  <div className="campaign-error-rail">
                    <div className="campaign-error-heading">
                      <TriangleAlert size={14} /> Recent errors <span>{erroredJobs.length}</span>
                    </div>
                    {erroredJobs.length ? (
                      erroredJobs.slice(-3).map((job) => (
                        <div key={job.id} className="campaign-error-entry">
                          <strong>{job.operation}</strong>
                          <span>{job.lastError}</span>
                          <small>
                            Attempt {job.attemptCount} of {job.maxAttempts}
                          </small>
                        </div>
                      ))
                    ) : (
                      <div className="campaign-no-errors">No job errors in this snapshot.</div>
                    )}
                  </div>
                </>
              )}
            </aside>
          </div>
          <footer className="campaign-detail-foot">
            <span>Latest progress: {latest ? relative(latest.occurredAt) : "No events"}</span>
            <span>Next: {nextAction}</span>
            <span>
              Observed {snapshot ? new Date(snapshot.observedAt).toLocaleTimeString() : "—"}
            </span>
          </footer>
        </div>
        {configOpen && configDraft && (
          <div className="campaign-modal-backdrop" role="presentation">
            <section
              className="campaign-modal"
              ref={configDialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="edit-campaign-title"
            >
              <div className="campaign-modal-head">
                <div>
                  <div className="campaign-eyebrow">REVISION {campaign.revision}</div>
                  <h2 id="edit-campaign-title">Edit campaign setup</h2>
                </div>
                <button
                  className="campaign-icon-button"
                  aria-label="Close dialog"
                  onClick={() => setConfigOpen(false)}
                  type="button"
                >
                  ×
                </button>
              </div>
              <form
                className="campaign-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run("config", async () => {
                    await updateConfig(configDraft);
                    setConfigOpen(false);
                  });
                }}
              >
                <label>
                  Campaign name
                  <input
                    required
                    maxLength={120}
                    value={configDraft.name}
                    onChange={(event) =>
                      setConfigDraft({
                        ...configDraft,
                        name: event.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  Website URL
                  <input
                    required
                    type="url"
                    value={configDraft.websiteUrl}
                    onChange={(event) =>
                      setConfigDraft({
                        ...configDraft,
                        websiteUrl: event.target.value,
                      })
                    }
                  />
                </label>
                <div className="campaign-form-row">
                  <label>
                    Language
                    <input
                      required
                      value={configDraft.language}
                      onChange={(event) =>
                        setConfigDraft({
                          ...configDraft,
                          language: event.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    Market
                    <input
                      required
                      value={configDraft.market}
                      onChange={(event) =>
                        setConfigDraft({
                          ...configDraft,
                          market: event.target.value,
                        })
                      }
                    />
                  </label>
                </div>
                <label>
                  Objective
                  <textarea
                    required
                    maxLength={2000}
                    rows={3}
                    value={configDraft.objective}
                    onChange={(event) =>
                      setConfigDraft({
                        ...configDraft,
                        objective: event.target.value,
                      })
                    }
                  />
                </label>
                <div className="campaign-form-row">
                  <label>
                    Daily registration limit
                    <input
                      type="number"
                      min={0}
                      max={1000}
                      value={configDraft.dailyRegistrationLimit}
                      onChange={(event) =>
                        setConfigDraft({
                          ...configDraft,
                          dailyRegistrationLimit: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label>
                    Daily publication limit
                    <input
                      type="number"
                      min={0}
                      max={1000}
                      value={configDraft.dailyPublicationLimit}
                      onChange={(event) =>
                        setConfigDraft({
                          ...configDraft,
                          dailyPublicationLimit: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                </div>
                <label>
                  Daily spend limit (USD)
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={configDraft.dailySpendLimitMicros / 1_000_000}
                    onChange={(event) =>
                      setConfigDraft({
                        ...configDraft,
                        dailySpendLimitMicros: Math.round(Number(event.target.value) * 1_000_000),
                      })
                    }
                  />
                </label>
                <div className="campaign-zero-spend">
                  <ShieldCheck size={15} />
                  <span>
                    Publication review is always required. Editing a draft resets its approval.
                  </span>
                </div>
                <div className="campaign-modal-actions">
                  <button
                    type="button"
                    className="campaign-secondary-button"
                    onClick={() => setConfigOpen(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="campaign-primary-button"
                    disabled={working !== null}
                  >
                    {working === "config" ? "Saving…" : "Save setup"}
                  </button>
                </div>
              </form>
            </section>
          </div>
        )}
        {stopConfirm && (
          <div className="campaign-modal-backdrop" role="presentation">
            <section
              className="campaign-modal pause-confirm-modal"
              ref={pauseDialogRef}
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="pause-all-title"
              aria-describedby="pause-all-copy"
            >
              <div className="campaign-modal-head">
                <div>
                  <div className="campaign-eyebrow">CAMPAIGN CONTROL</div>
                  <h2 id="pause-all-title">Pause all active campaigns?</h2>
                </div>
                <button
                  className="campaign-icon-button"
                  aria-label="Close dialog"
                  disabled={stopPending}
                  onClick={() => setStopConfirm(false)}
                  type="button"
                >
                  ×
                </button>
              </div>
              <p id="pause-all-copy">
                This pauses every active campaign in your workspace. You can resume campaigns
                individually.
              </p>
              {actionError && (
                <div className="campaign-form-error" role="alert">
                  {actionError}
                </div>
              )}
              <div className="campaign-modal-actions">
                <button
                  type="button"
                  className="campaign-secondary-button"
                  disabled={stopPending}
                  onClick={() => setStopConfirm(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="campaign-primary-button pause-all-confirm"
                  disabled={stopPending}
                  onClick={() => void pauseAll()}
                >
                  {stopPending ? "Pausing…" : "Pause all"}
                </button>
              </div>
            </section>
          </div>
        )}
        {publishConfirm && (
          <div className="campaign-modal-backdrop" role="presentation">
            <section
              className="campaign-modal publication-confirm-modal"
              ref={publishDialogRef}
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="publish-confirm-title"
              aria-describedby="publish-confirm-copy"
            >
              <div className="campaign-modal-head">
                <div>
                  <div className="campaign-eyebrow">EXTERNAL PUBLICATION</div>
                  <h2 id="publish-confirm-title">Publish this reviewed draft?</h2>
                </div>
                <button
                  className="campaign-icon-button"
                  aria-label="Close publication confirmation"
                  disabled={working !== null}
                  onClick={() => setPublishConfirm(null)}
                  type="button"
                >
                  ×
                </button>
              </div>
              <p id="publish-confirm-copy">
                This sends “{publishConfirm.item.title}” to topic {publishConfirm.topicId} on the
                configured Discourse service. Confirm only if you reviewed the latest draft and are
                authorized to publish it.
              </p>
              <label className="publication-confirm-check">
                <input
                  type="checkbox"
                  checked={publishAuthorized}
                  onChange={(event) => setPublishAuthorized(event.currentTarget.checked)}
                />{" "}
                I reviewed this exact draft and authorize this external post.
              </label>
              <div className="campaign-modal-actions">
                <button
                  type="button"
                  className="campaign-secondary-button"
                  disabled={working !== null}
                  onClick={() => setPublishConfirm(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="campaign-primary-button"
                  disabled={working !== null || !publishAuthorized}
                  onClick={() => {
                    const current = publishConfirm;
                    if (!current) return;
                    void run(`publish-${current.item.id}`, async () => {
                      await publishDraft(current.item, current.topicId);
                      setPublishConfirm(null);
                      setPublishAuthorized(false);
                      setTab("Results");
                    });
                  }}
                >
                  {working?.startsWith("publish-") ? "Submitting…" : "Confirm and publish"}
                </button>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

function formatCatalogToken(value: string) {
  return value.replaceAll("_", " ");
}

function DiscoveryPanel({
  summary,
  jobs,
  mode,
  websiteUrl,
  working,
  onRecover,
  onReview,
}: {
  summary: ReturnType<typeof summarizeDiscovery>;
  jobs: CampaignJob[];
  mode: CampaignMode;
  websiteUrl: string;
  working: string | null;
  onRecover: (item: CampaignItem, action: CampaignRecoveryAction) => void;
  onReview: (item: CampaignItem, action: "select" | "dismiss") => void;
}) {
  const candidateCountBySearch = new Map(
    summary.searches.map((search) => [
      search.item.id,
      countCandidatesForSearch(search, summary.candidates),
    ]),
  );
  return (
    <section className="campaign-discovery-section" aria-labelledby="discovery-heading">
      <div className="campaign-panel-heading discovery-heading">
        <div>
          <h2 id="discovery-heading">Community discovery</h2>
          <p>Search and inspection tasks from the configured site’s research run</p>
        </div>
        <span className="catalog-page-count">{summary.candidates.length} observed candidates</span>
      </div>
      {mode === "controlled" ? (
        <div className="discovery-empty">
          Community search is not run in Controlled test. Only explicit local fixture outcomes are
          available.
        </div>
      ) : summary.searches.length === 0 && summary.candidates.length === 0 ? (
        <div className="discovery-empty">
          No community search has run yet. Review the catalog and activity for source or connection
          issues. Any observed candidate requires your explicit review before focused research
          begins.
        </div>
      ) : (
        <>
          {summary.searches.length > 0 && (
            <section className="discovery-search-list" aria-label="Community search queries">
              {summary.searches.map((search) => {
                const actions = campaignRecoveryActions(search.item, search.job, mode);
                return (
                  <article className="discovery-search-row" key={search.item.id}>
                    <div className="discovery-search-copy">
                      <strong>{search.metadata.query}</strong>
                      <span>
                        {search.metadata.provider} ·{" "}
                        {candidateCountBySearch.get(search.item.id) ?? 0} linked candidates
                      </span>
                    </div>
                    <span
                      className={`campaign-status job-status-${search.job?.status ?? search.item.status}`}
                    >
                      <i />{" "}
                      {statusNames[search.job?.status ?? search.item.status] ??
                        search.job?.status ??
                        search.item.status}
                    </span>
                    <span className="campaign-attempt">
                      {search.job
                        ? `Attempt ${search.job.attemptCount}/${search.job.maxAttempts}`
                        : "No task record"}
                    </span>
                    {search.job?.lastError && (
                      <span className="campaign-job-error">
                        <TriangleAlert size={13} /> {discoveryErrorMessage(search.job.lastError)}
                        <small>{search.job.lastError}</small>
                      </span>
                    )}
                    {actions.length > 0 && (
                      <div className="campaign-recovery-actions">
                        {actions.map((action) => (
                          <button
                            key={action}
                            className="campaign-secondary-button"
                            disabled={working !== null}
                            onClick={() => onRecover(search.item, action)}
                            type="button"
                          >
                            {action === "retry"
                              ? "Retry search"
                              : action === "defer"
                                ? "Defer 5 min"
                                : "Skip search"}
                          </button>
                        ))}
                      </div>
                    )}
                  </article>
                );
              })}
            </section>
          )}
          {summary.candidates.length > 0 && (
            <section
              className="discovery-candidate-list"
              aria-label="Observed community candidates"
            >
              {summary.candidates.map((candidate) => (
                <DiscoveryCandidateCard
                  key={candidate.item.id}
                  candidate={candidate}
                  jobs={jobs}
                  websiteUrl={websiteUrl}
                  working={working !== null}
                  onRecover={onRecover}
                  onReview={onReview}
                />
              ))}
            </section>
          )}
        </>
      )}
      <div className="campaign-capability-note">
        <CircleHelp size={14} />
        <span>
          Search results are observations only. “Use for research” starts one focused research job;
          it does not register an account, approve a contribution, or publish anything.
        </span>
      </div>
    </section>
  );
}

function DiscoveryCandidateCard({
  candidate,
  jobs,
  websiteUrl,
  working,
  onRecover,
  onReview,
}: {
  candidate: DiscoveryRecord;
  jobs: CampaignJob[];
  websiteUrl: string;
  working: boolean;
  onRecover: (item: CampaignItem, action: CampaignRecoveryAction) => void;
  onReview: (item: CampaignItem, action: "select" | "dismiss") => void;
}) {
  const selected = candidate.metadata.disposition === "selected";
  const dismissed = candidate.metadata.disposition === "dismissed";
  const researchJob = [...jobs]
    .reverse()
    .find((job) => job.itemId === candidate.item.id && job.operation === "research_opportunity");
  const actionJob = selected ? researchJob : candidate.job;
  const actions = campaignRecoveryActions(candidate.item, actionJob, "research");
  const stateLabel = selected
    ? "Selected for research"
    : dismissed
      ? "Dismissed"
      : candidate.metadata.inspection === "observed"
        ? "Observed · needs your review"
        : candidate.metadata.inspection === "unavailable"
          ? "Inspection unavailable"
          : "Inspection pending";
  const recoveryReason =
    typeof candidate.item.details.recoveryReason === "string"
      ? candidate.item.details.recoveryReason
      : null;
  return (
    <article className="discovery-candidate-card">
      <div className="campaign-content-item-top">
        <span className="campaign-kind">Observed candidate</span>
        <span className={`campaign-status item-${candidate.item.status}`}>
          <i /> {stateLabel}
        </span>
      </div>
      <h3>{candidate.item.title}</h3>
      {candidate.item.url && (
        <a href={candidate.item.url} target="_blank" rel="noreferrer">
          {candidate.item.url}
          <ExternalLink size={12} />
        </a>
      )}
      <p className="discovery-evidence">{candidate.excerpt || candidate.item.body}</p>
      <div className="discovery-candidate-meta">
        {candidate.metadata.rank !== undefined && (
          <span>Search rank {candidate.metadata.rank}</span>
        )}
        {candidate.metadata.observedAt && (
          <span>Observed {relative(candidate.metadata.observedAt)}</span>
        )}
        <span>Provider: {candidate.metadata.provider}</span>
        <span>Query: {candidate.metadata.query}</span>
        <span>Official catalog sources: {candidate.metadata.sourceItemIds.length}</span>
        {candidate.metadata.platformHint === "discourse" && (
          <span>Possible Discourse forum · not verified</span>
        )}
      </div>
      {candidate.metadata.rulesLinks.length > 0 && (
        <section className="discovery-rules" aria-label="Site rules links not reviewed">
          <strong>Site rules observed · not reviewed</strong>
          {candidate.metadata.rulesLinks.map((link) => (
            <a key={link.url} href={link.url} target="_blank" rel="noreferrer">
              {link.label} <ExternalLink size={11} />
            </a>
          ))}
        </section>
      )}
      {recoveryReason && <p className="discovery-selection-note">{recoveryReason}</p>}
      {(candidate.job?.lastError || researchJob?.lastError) && (
        <p className="campaign-job-error discovery-error">
          <TriangleAlert size={13} />
          <span>
            {discoveryErrorMessage(selected ? researchJob?.lastError : candidate.job?.lastError)}
            <small>{selected ? researchJob?.lastError : candidate.job?.lastError}</small>
          </span>
        </p>
      )}
      {selected && (
        <p className="discovery-selection-note">
          Research task:{" "}
          {statusNames[researchJob?.status ?? candidate.item.status] ??
            researchJob?.status ??
            candidate.item.status}
          . This is not approval to contribute or publish.
        </p>
      )}
      {candidate.metadata.disposition === "unreviewed" && (
        <div className="campaign-recovery-actions discovery-review-actions">
          <button
            className="campaign-primary-button compact"
            disabled={working || !canSelectDiscoveryRecord(candidate, websiteUrl)}
            onClick={() => onReview(candidate.item, "select")}
            type="button"
          >
            Use for research
          </button>
          <button
            className="campaign-secondary-button reject"
            disabled={working || !canDismissDiscoveryRecord(candidate)}
            onClick={() => onReview(candidate.item, "dismiss")}
            type="button"
          >
            Dismiss
          </button>
        </div>
      )}
      {actions.length > 0 && (
        <div className="campaign-recovery-actions">
          {actions.map((action) => (
            <button
              key={action}
              className="campaign-secondary-button"
              disabled={working}
              onClick={() => onRecover(candidate.item, action)}
              type="button"
            >
              {action === "retry"
                ? "Retry inspection"
                : action === "defer"
                  ? "Defer 5 min"
                  : "Skip inspection"}
            </button>
          ))}
        </div>
      )}
    </article>
  );
}

function CatalogPanel({
  progress,
  jobs,
  mode,
  websiteUrl,
  onRecover,
  working,
}: {
  progress: CatalogProgress;
  jobs: CampaignJob[];
  mode: CampaignMode;
  websiteUrl: string;
  onRecover: (item: CampaignItem, action: CampaignRecoveryAction) => void;
  working: string | null;
}) {
  return (
    <BuiCard className="campaign-panel catalog-panel">
      <div className="campaign-panel-heading">
        <div>
          <h2>Official website catalog</h2>
          <p>
            Configured site{" "}
            <a href={websiteUrl} target="_blank" rel="noreferrer">
              {websiteUrl}
            </a>
          </p>
        </div>
        {mode === "research" ? (
          <span className="catalog-page-count">{progress.pages.length} page records</span>
        ) : (
          <span className="campaign-mode controlled">Controlled test</span>
        )}
      </div>
      {mode === "controlled" ? (
        <div className="campaign-panel-empty">
          <span className="campaign-empty-icon small">
            <CircleHelp size={18} />
          </span>
          <strong>Website catalog is not run in Controlled test</strong>
          <span>
            Controlled test uses the explicit URLs you add and local fixture outcomes only.
          </span>
        </div>
      ) : (
        <>
          <fieldset className="catalog-progress" aria-label="Persisted catalog task progress">
            <div>
              <span>Pages recorded</span>
              <strong>{progress.pages.length}</strong>
            </div>
            <div>
              <span>Observed candidates</span>
              <strong>{progress.candidates.length}</strong>
            </div>
            <div>
              <span>Queued</span>
              <strong>{progress.queued}</strong>
            </div>
            <div>
              <span>In progress</span>
              <strong>{progress.running}</strong>
            </div>
            <div>
              <span>Deferred</span>
              <strong>{progress.deferred}</strong>
            </div>
            <div>
              <span>Needs action / failed</span>
              <strong>{progress.needsAction}</strong>
            </div>
            <div>
              <span>Optional probes not found</span>
              <strong>{progress.notFound}</strong>
            </div>
            <div>
              <span>Worker completed</span>
              <strong>{progress.succeeded}</strong>
            </div>
          </fieldset>
          {progress.guidanceBlocked && (
            <div className="campaign-inline-alert catalog-guidance-alert" role="status">
              <TriangleAlert size={14} /> Website crawl guidance needs attention. See its catalog
              record for the worker-provided reason.
            </div>
          )}
          {progress.guidanceSkipped && (
            <div className="campaign-inline-alert catalog-guidance-alert" role="status">
              <TriangleAlert size={14} /> Website crawl guidance was skipped. Cataloging is blocked;
              no pages were fetched.
            </div>
          )}
          {progress.pages.length === 0 ? (
            <div className="campaign-panel-empty">
              <span className="campaign-empty-icon small">
                <Activity size={18} />
              </span>
              <strong>No catalog pages recorded yet</strong>
              <span>
                Start the research campaign to begin a bounded read-only catalog of the configured
                website. Manual URLs are optional.
              </span>
            </div>
          ) : (
            <div className="campaign-catalog-pages">
              {progress.pages.map((page) => (
                <CatalogPageCard
                  key={page.item.id}
                  page={page}
                  jobs={jobs.filter((job) => job.itemId === page.item.id)}
                  onRecover={onRecover}
                  working={working === `recover-${page.item.id}`}
                />
              ))}
            </div>
          )}
          <div className="campaign-capability-note">
            <CircleHelp size={14} />
            <span>
              Each run is bounded to 12 pages and depth 2. The catalog shows pages the worker
              actually fetched. Links observed on those pages are candidates only; they are not
              fetched or verified by appearing here. This is not a completeness claim about the
              website.
            </span>
          </div>
        </>
      )}
    </BuiCard>
  );
}

function CatalogPageCard({
  page,
  jobs,
  onRecover,
  working,
}: {
  page: CatalogPage;
  jobs: CampaignJob[];
  onRecover: (item: CampaignItem, action: CampaignRecoveryAction) => void;
  working: boolean;
}) {
  const failures = jobs.filter((job) => job.lastError).map((job) => job.lastError as string);
  const optionalAbsence = jobs.some((job) => isExpectedCatalogAbsence(page.item, job));
  const excerpt = page.evidence.find((entry) => entry.excerpt)?.excerpt ?? page.item.body;
  return (
    <article className="campaign-catalog-page">
      <div className="campaign-content-item-top">
        <span className="campaign-kind">{formatCatalogToken(page.metadata.category)}</span>
        <span className={`campaign-status item-${page.item.status}`}>
          <i />
          {optionalAbsence
            ? "Not found"
            : page.item.status === "verified"
              ? "Fetched"
              : (statusNames[page.item.status] ?? page.item.status)}
        </span>
      </div>
      <h3>{page.item.title}</h3>
      <a href={page.item.url ?? undefined} target="_blank" rel="noreferrer">
        {page.item.url}
        <ExternalLink size={12} />
      </a>
      <div className="campaign-catalog-meta">
        <span>Site run: {page.metadata.runId.slice(0, 12)}</span>
        <span>Run root: {page.metadata.rootUrl}</span>
        <span>Purpose: {formatCatalogToken(page.metadata.purpose)}</span>
        <span>Page type (inferred): {formatCatalogToken(page.metadata.category)}</span>
        <span>Source: {formatCatalogToken(page.metadata.provenance)}</span>
        <span>Depth {page.metadata.depth}</span>
        {jobs.map((job) => (
          <span key={job.id}>
            Task {statusNames[job.status] ?? job.status} · attempt {job.attemptCount}/
            {job.maxAttempts}
          </span>
        ))}
      </div>
      {excerpt && (
        <div className="campaign-catalog-evidence">
          <strong>Fetched evidence</strong>
          <p>{excerpt.slice(0, 2_000)}</p>
          {page.evidence[0]?.fetchedAt && (
            <time dateTime={page.evidence[0].fetchedAt}>
              Fetched {relative(page.evidence[0].fetchedAt)}
            </time>
          )}
        </div>
      )}
      {failures.map((failure, index) => (
        <p className="campaign-job-error catalog-error" key={`${page.item.id}-${index}`}>
          <TriangleAlert size={13} />
          {failure}
        </p>
      ))}
      {jobs.map((job) => {
        const actions = campaignRecoveryActions(page.item, job, "research");
        if (actions.length === 0) return null;
        return (
          <div className="campaign-recovery-actions" key={`${job.id}-recovery`}>
            {actions.map((action) => (
              <button
                key={action}
                className="campaign-secondary-button"
                type="button"
                disabled={working}
                onClick={() => onRecover(page.item, action)}
                aria-label={`${action === "retry" ? "Retry" : action === "defer" ? "Defer" : "Skip"} catalog page ${page.item.title}`}
              >
                {working && action === "retry"
                  ? "Updating…"
                  : action === "retry"
                    ? "Retry"
                    : action === "defer"
                      ? "Defer 5 min"
                      : "Skip"}
              </button>
            ))}
          </div>
        );
      })}
      {page.candidates.length > 0 && (
        <section
          className="campaign-catalog-candidates"
          aria-label={`Unverified links observed on ${page.item.title}`}
        >
          <h4>Observed link candidates · not fetched</h4>
          {page.candidates.map((candidate) => (
            <div className="campaign-catalog-candidate" key={`${candidate.url}:${candidate.label}`}>
              <div>
                <strong>{candidate.label}</strong>
                <span>{formatCatalogToken(candidate.category)} · candidate</span>
              </div>
              <a
                href={candidate.url}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open candidate ${candidate.label}`}
              >
                {candidate.url}
                <ExternalLink size={11} />
              </a>
            </div>
          ))}
        </section>
      )}
      <time>{relative(page.item.updatedAt)}</time>
    </article>
  );
}

function PublicationActionRow({
  action,
  working,
  onVerify,
}: {
  action: CampaignPublicationAction;
  working: boolean;
  onVerify: () => void;
}) {
  const canVerify =
    ["submitted", "pending"].includes(action.status) && action.providerPostId !== null;
  const wait = action.nextVerifyAt ? Date.parse(action.nextVerifyAt) > Date.now() : false;
  return (
    <article className="publication-action-row">
      <span className={`challenge-state ${action.status}`}>{action.status}</span>
      <div>
        <strong>
          Topic {action.topicId} ·{" "}
          {action.status === "verified"
            ? "Verified post"
            : canVerify
              ? "Public verification pending"
              : action.status === "ambiguous"
                ? "Uncertain submission · inspect before retry"
                : action.status}
        </strong>
        <span>
          {action.safeError ??
            `Verification ${action.verificationAttempts}/${action.maxVerificationAttempts} · updated ${relative(action.updatedAt)}`}
        </span>
        {canVerify && (
          <small>
            Service check {publicationNextCheck(action.nextVerifyAt)} · deadline{" "}
            {new Date(action.deadlineAt).toLocaleString()}
          </small>
        )}
        {action.status === "ambiguous" && (
          <small>
            Do not resubmit. Check this action or contact the deployment owner before any further
            attempt.
          </small>
        )}
        {action.publicUrl && (
          <a href={action.publicUrl} target="_blank" rel="noreferrer">
            Open published post <ExternalLink size={12} />
          </a>
        )}
      </div>
      {canVerify && (
        <button
          className="campaign-secondary-button"
          disabled={working || wait}
          onClick={onVerify}
          type="button"
        >
          {working
            ? "Checking…"
            : wait
              ? `Check available ${publicationNextCheck(action.nextVerifyAt)}`
              : "Check now"}
        </button>
      )}
    </article>
  );
}

function ContentItem({
  item,
  mode,
  jobs = [],
  working = false,
  onRecover,
}: {
  item: CampaignItem;
  mode?: CampaignMode;
  jobs?: CampaignJob[];
  working?: boolean;
  onRecover?: (action: CampaignRecoveryAction) => void;
}) {
  const job = [...jobs]
    .reverse()
    .find(
      (candidate) => candidate.itemId === item.id && candidate.operation.startsWith("research_"),
    );
  const actions = mode ? campaignRecoveryActions(item, job, mode) : [];
  const verification = item.details.verification;
  const independentlyVerifiedFixture =
    item.kind === "publication" &&
    item.status === "verified" &&
    item.details.effect === "local_fixture_only" &&
    typeof verification === "object" &&
    verification !== null &&
    "method" in verification &&
    verification.method === "independent_fixture_read";
  return (
    <article className="campaign-content-item">
      <div className="campaign-content-item-top">
        <span className="campaign-kind">{item.kind}</span>
        <span className={`campaign-status item-${item.status}`}>
          <i />
          {statusNames[item.status] ?? item.status}
        </span>
      </div>
      <h3>{item.title}</h3>
      {item.body && <p>{item.body}</p>}
      {independentlyVerifiedFixture && (
        <p className="campaign-fixture-verification">
          Independently verified by the controlled fixture.
        </p>
      )}
      {item.url && (
        <a href={item.url} target="_blank" rel="noreferrer">
          {item.url}
          <ExternalLink size={12} />
        </a>
      )}
      {actions.length > 0 && (
        <div className="campaign-recovery-actions">
          {actions.includes("retry") && (
            <button
              className="campaign-secondary-button"
              aria-label={`Retry ${item.title}`}
              disabled={working}
              onClick={() => onRecover?.("retry")}
              type="button"
            >
              Retry
            </button>
          )}
          {actions.includes("defer") && (
            <button
              className="campaign-secondary-button"
              aria-label={`Defer ${item.title} for five minutes`}
              disabled={working}
              onClick={() => onRecover?.("defer")}
              type="button"
            >
              Defer 5 min
            </button>
          )}
          {actions.includes("skip") && (
            <button
              className="campaign-secondary-button reject"
              aria-label={`Skip ${item.title}`}
              disabled={working}
              onClick={() => onRecover?.("skip")}
              type="button"
            >
              Skip
            </button>
          )}
        </div>
      )}
      <time>{relative(item.updatedAt)}</time>
    </article>
  );
}
function AccountItem({ item, mode }: { item: CampaignItem; mode: "research" | "controlled" }) {
  const label = typeof item.details.label === "string" ? item.details.label : null;
  const confirmation = item.details.emailConfirmation;
  const confirmationStatus =
    confirmation &&
    typeof confirmation === "object" &&
    !Array.isArray(confirmation) &&
    "status" in confirmation &&
    typeof confirmation.status === "string"
      ? confirmation.status
      : null;
  return (
    <article className="campaign-content-item">
      <div className="campaign-content-item-top">
        <span className="campaign-kind">Account record</span>
        <span className={`campaign-status item-${item.status}`}>
          <i />
          {statusNames[item.status] ?? item.status}
        </span>
      </div>
      <h3>{item.title}</h3>
      {label && <p>{label}</p>}
      <div className="campaign-account-meta">
        <span>Live registration: unavailable</span>
        {confirmationStatus && <span>Email fixture: {confirmationStatus}</span>}
      </div>
      {mode === "controlled" && (
        <span className="campaign-mode controlled account-fixture-label">Test-only fixture</span>
      )}
      <time>{relative(item.updatedAt)}</time>
    </article>
  );
}
function DraftCard({
  item,
  websiteUrl,
  working,
  editing,
  body,
  onEdit,
  onBody,
  onCancel,
  onSave,
  onReview,
}: {
  item: CampaignItem;
  websiteUrl: string;
  working: boolean;
  editing: boolean;
  body: string;
  onEdit: () => void;
  onBody: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
  onReview: (decision: "approve" | "reject") => void;
}) {
  const [showMeta, setShowMeta] = useState(false);
  const needsReview = item.status === "ready" || item.status === "needs_action";
  const projectContext = readDraftProjectContext(item, websiteUrl);
  return (
    <article className="campaign-draft-card">
      <div className="campaign-content-item-top">
        <span className="campaign-kind">Draft</span>
        <span className={`campaign-status item-${item.status}`}>
          <i />
          {item.status === "needs_action"
            ? "Needs review"
            : (statusNames[item.status] ?? item.status)}
        </span>
      </div>
      <h3>{item.title}</h3>
      {editing ? (
        <textarea
          aria-label={`Edit ${item.title}`}
          maxLength={20_000}
          rows={6}
          value={body}
          onChange={(event) => onBody(event.target.value)}
        />
      ) : (
        <p className="draft-body">{item.body || "No draft text returned yet."}</p>
      )}
      {item.url && (
        <a href={item.url} target="_blank" rel="noreferrer">
          {item.url}
          <ExternalLink size={12} />
        </a>
      )}
      <button
        className="campaign-text-button draft-meta-toggle"
        onClick={() => setShowMeta((value) => !value)}
        type="button"
      >
        {showMeta ? "Hide details" : "Details"}
      </button>
      {showMeta && (
        <div className="campaign-draft-meta">
          <span>Updated {relative(item.updatedAt)}</span>
          <span>Any edit clears prior approval.</span>
          {projectContext && (
            <section className="draft-project-context" aria-label="Official project context">
              <strong>
                {projectContext.state === "available"
                  ? "Official sources available for review"
                  : projectContext.state === "supplied"
                    ? "Official sources supplied to the model"
                    : "No verified official sources available"}
              </strong>
              {projectContext.state === "available" && (
                <span>These references were available but not sent to an AI model.</span>
              )}
              {projectContext.isHistorical && projectContext.rootUrl && (
                <span>
                  Historical context from {projectContext.rootUrl}; campaign website is now{" "}
                  {websiteUrl}. Existing evidence is retained for review.
                </span>
              )}
              {projectContext.references.length > 0 && (
                <details className="draft-official-references">
                  <summary>Official references ({projectContext.references.length})</summary>
                  {projectContext.references.map((reference) => (
                    <article key={reference.id}>
                      <a href={reference.url} target="_blank" rel="noreferrer">
                        {reference.title} <ExternalLink size={11} />
                      </a>
                      <time dateTime={reference.fetchedAt}>
                        Fetched {relative(reference.fetchedAt)}
                      </time>
                      <p>{reference.excerpt}</p>
                    </article>
                  ))}
                </details>
              )}
            </section>
          )}
        </div>
      )}
      {editing ? (
        <div className="campaign-draft-actions">
          <button className="campaign-secondary-button" onClick={onCancel} type="button">
            <X size={14} /> Cancel
          </button>
          <button
            className="campaign-primary-button compact"
            disabled={working}
            onClick={onSave}
            type="button"
          >
            {working ? "Saving…" : "Save changes"}
          </button>
        </div>
      ) : (
        <div className="campaign-draft-actions">
          <button
            className="campaign-secondary-button"
            disabled={working}
            onClick={onEdit}
            type="button"
          >
            Edit draft
          </button>
          {needsReview && (
            <>
              <button
                className="campaign-secondary-button reject"
                disabled={working}
                onClick={() => onReview("reject")}
                type="button"
              >
                Reject
              </button>
              <button
                className="campaign-primary-button compact"
                disabled={working}
                onClick={() => onReview("approve")}
                type="button"
              >
                <Check size={14} /> Approve
              </button>
            </>
          )}
        </div>
      )}
    </article>
  );
}
