import {
  Activity,
  ArrowUpRight,
  Bot,
  CircleHelp,
  Plus,
  Radar,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BuiButton, BuiCard } from "../../components/beautiful-ui/primitives";
import { useCampaignList } from "../../lib/campaign-data";
import type { CampaignConfig, CampaignMode } from "../../lib/campaign-types";
import { useCampaignDialog } from "./use-campaign-dialog";
import "./campaigns.css";

const emptyConfig: CampaignConfig = {
  name: "",
  websiteUrl: "",
  language: "English",
  market: "United States",
  objective: "",
  dailyRegistrationLimit: 0,
  dailyPublicationLimit: 0,
  dailySpendLimitMicros: 0,
  requirePublicationReview: true,
};

function when(date: string) {
  const value = new Date(date).getTime();
  if (!Number.isFinite(value)) return "—";
  const minutes = Math.floor((Date.now() - value) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24
    ? `${hours}h ago`
    : new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
      }).format(value);
}

export function CampaignDashboard() {
  const navigate = useNavigate();
  const { campaigns, loading, error, refresh, create, stopAll } = useCampaignList();
  const [dialog, setDialog] = useState(false);
  const [form, setForm] = useState<CampaignConfig>(emptyConfig);
  const [mode, setMode] = useState<CampaignMode>("research");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [archived, setArchived] = useState(false);
  const [stopConfirm, setStopConfirm] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [stopNotice, setStopNotice] = useState<string | null>(null);
  const createDialogRef = useCampaignDialog(dialog, () => setDialog(false), !saving);
  const pauseDialogRef = useCampaignDialog(stopConfirm, () => setStopConfirm(false), !stopPending);
  const visible = campaigns.filter((item) =>
    archived ? item.status === "archived" : item.status !== "archived",
  );
  const activeCount = campaigns.filter((item) => item.status === "active").length;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const campaign = await create(form, mode);
      setDialog(false);
      setForm(emptyConfig);
      setMode("research");
      navigate(`/app/campaigns/${encodeURIComponent(campaign.id)}`);
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "Campaign could not be created");
    } finally {
      setSaving(false);
    }
  }
  async function pauseAll() {
    setStopPending(true);
    setStopError(null);
    try {
      const result = await stopAll();
      setStopNotice(
        `Paused ${result.pausedCount} active campaign${result.pausedCount === 1 ? "" : "s"}.`,
      );
      setStopConfirm(false);
    } catch (cause) {
      setStopError(cause instanceof Error ? cause.message : "Could not pause campaigns");
    } finally {
      setStopPending(false);
    }
  }

  return (
    <div className="campaign-app">
      <aside className="campaign-sidebar">
        <div className="campaign-brand">
          <span className="campaign-brand-mark">
            <Radar size={17} />
          </span>
          <span>AutoSEO</span>
          <span className="campaign-brand-dot" />
        </div>
        <div className="campaign-nav-label">WORKSPACE</div>
        <button className="campaign-nav-item active" aria-current="page" type="button">
          <Activity size={16} /> Campaigns <span>{campaigns.length}</span>
        </button>
        <div className="campaign-sidebar-spacer" />
        <div className="campaign-sidebar-note">
          <ShieldCheck size={16} />
          <span>Publication always requires your review.</span>
        </div>
        <a className="campaign-legacy-link" href="/app/agents">
          Open agent workspace <ArrowUpRight size={14} />
        </a>
      </aside>

      <main className="campaign-main">
        <header className="campaign-topbar">
          <div>
            <span className="campaign-crumb">Workspace</span>
            <span className="campaign-crumb-sep">/</span>
            <strong>Campaigns</strong>
          </div>
          <div className="campaign-topbar-right">
            <span className="campaign-live-dot" /> Campaign control center
          </div>
        </header>
        <div className="campaign-content">
          <section className="campaign-heading-row">
            <div>
              <div className="campaign-eyebrow">
                AUTOMATION STUDIO <span>·</span> CAMPAIGN CONTROL
              </div>
              <h1>Your campaigns</h1>
              <p>Research opportunities, shape drafts, and keep every action under your review.</p>
            </div>
            <div className="campaign-heading-actions">
              {activeCount > 0 && (
                <button
                  className="campaign-secondary-button pause-all-button"
                  onClick={() => {
                    setStopError(null);
                    setStopConfirm(true);
                  }}
                  type="button"
                >
                  Pause all <span>{activeCount}</span>
                </button>
              )}
              <BuiButton
                tone="accent"
                onClick={() => {
                  setDialog(true);
                  setFormError(null);
                }}
              >
                <span className="campaign-button-inner">
                  <Plus size={16} /> New campaign
                </span>
              </BuiButton>
            </div>
          </section>
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

          <section className="campaign-metrics" aria-label="Campaign overview">
            <BuiCard className="campaign-metric">
              <span className="metric-icon cyan">
                <Radar size={17} />
              </span>
              <span className="metric-label">Total campaigns</span>
              <strong>{loading && campaigns.length === 0 ? "—" : campaigns.length}</strong>
              <span className="metric-foot">Across this workspace</span>
            </BuiCard>
            <BuiCard className="campaign-metric">
              <span className="metric-icon violet">
                <Activity size={17} />
              </span>
              <span className="metric-label">In progress</span>
              <strong>{campaigns.filter((item) => item.status === "active").length}</strong>
              <span className="metric-foot">Research or review underway</span>
            </BuiCard>
            <BuiCard className="campaign-metric">
              <span className="metric-icon green">
                <ShieldCheck size={17} />
              </span>
              <span className="metric-label">Review queue</span>
              <strong>Campaign level</strong>
              <span className="metric-foot">Open a campaign to see drafts needing review</span>
            </BuiCard>
            <BuiCard className="campaign-metric">
              <span className="metric-icon muted">
                <Bot size={17} />
              </span>
              <span className="metric-label">Operating mode</span>
              <strong>Research first</strong>
              <span className="metric-foot">No paid or external publishing actions</span>
            </BuiCard>
          </section>

          <section className="campaign-list-section">
            <div className="campaign-section-head">
              <div>
                <h2>{archived ? "Archived campaigns" : "Campaign workspace"}</h2>
                <p>Configuration, current work, and a clear path to the next step.</p>
              </div>
              <div className="campaign-head-actions">
                <button
                  className="campaign-text-button"
                  onClick={() => setArchived((value) => !value)}
                  type="button"
                >
                  {archived ? "Show active" : "Archived"}
                </button>
                <button
                  className="campaign-icon-button"
                  aria-label="Refresh campaigns"
                  onClick={() => void refresh()}
                  type="button"
                >
                  <RefreshCw size={15} />
                </button>
              </div>
            </div>
            {error && (
              <div className="campaign-inline-alert" role="status">
                <span>Couldn&apos;t refresh campaigns.</span>
                <button onClick={() => void refresh()} type="button">
                  Retry
                </button>
              </div>
            )}
            {loading && campaigns.length === 0 ? (
              <div className="campaign-loading">
                <span className="campaign-spinner" /> Loading campaign data
              </div>
            ) : error && campaigns.length === 0 ? (
              <div className="campaign-empty">
                <span className="campaign-empty-icon small">
                  <RefreshCw size={18} />
                </span>
                <h3>Campaign data unavailable</h3>
                <p>The last campaign request did not complete.</p>
                <BuiButton onClick={() => void refresh()}>Retry</BuiButton>
              </div>
            ) : visible.length === 0 ? (
              <div className="campaign-empty">
                <span className="campaign-empty-icon">
                  <Radar size={24} />
                </span>
                <h3>{archived ? "No archived campaigns" : "Start with one clear objective"}</h3>
                <p>
                  {archived
                    ? "Archived work will stay available here."
                    : "Add your site and a goal. Research mode starts at zero spend and prepares reviewed drafts."}
                </p>
                {!archived && (
                  <BuiButton tone="accent" onClick={() => setDialog(true)}>
                    <span className="campaign-button-inner">
                      <Plus size={16} /> Create a campaign
                    </span>
                  </BuiButton>
                )}
              </div>
            ) : (
              <div className="campaign-grid">
                {visible.map((campaign) => (
                  <button
                    type="button"
                    className="campaign-card"
                    key={campaign.id}
                    onClick={() => navigate(`/app/campaigns/${encodeURIComponent(campaign.id)}`)}
                  >
                    <div className="campaign-card-top">
                      <span className={`campaign-status ${campaign.status}`}>
                        <i />
                        {campaign.status}
                      </span>
                      <span className={`campaign-mode ${campaign.mode}`}>
                        {campaign.mode === "controlled" ? "Controlled test" : "Research"}
                      </span>
                    </div>
                    <h3>{campaign.config.name}</h3>
                    <p className="campaign-card-url">{campaign.config.websiteUrl}</p>
                    <p className="campaign-card-objective">{campaign.config.objective}</p>
                    <div className="campaign-card-foot">
                      <span>Updated {when(campaign.updatedAt)}</span>
                      <span className="campaign-arrow">
                        <ArrowUpRight size={17} />
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>
          <footer className="campaign-footnote">
            <CircleHelp size={14} />
            <span>
              Research mode reads URLs you add and prepares drafts for review. External registration
              and publication actions are not available.
            </span>
          </footer>
        </div>
      </main>

      {dialog && (
        <div className="campaign-modal-backdrop" role="presentation">
          <section
            className="campaign-modal"
            ref={createDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-campaign-title"
          >
            <div className="campaign-modal-head">
              <div>
                <div className="campaign-eyebrow">NEW WORKFLOW</div>
                <h2 id="new-campaign-title">Create campaign</h2>
              </div>
              <button
                className="campaign-icon-button"
                aria-label="Close dialog"
                onClick={() => setDialog(false)}
                type="button"
              >
                ×
              </button>
            </div>
            <form onSubmit={(event) => void submit(event)} className="campaign-form">
              <label>
                Campaign name
                <input
                  required
                  maxLength={120}
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  placeholder="e.g. Product launch research"
                />
              </label>
              <label>
                Website URL
                <input
                  required
                  type="url"
                  value={form.websiteUrl}
                  onChange={(event) => setForm({ ...form, websiteUrl: event.target.value })}
                  placeholder="https://example.com"
                />
              </label>
              <div className="campaign-form-row">
                <label>
                  Language
                  <input
                    required
                    value={form.language}
                    onChange={(event) => setForm({ ...form, language: event.target.value })}
                  />
                </label>
                <label>
                  Market
                  <input
                    required
                    value={form.market}
                    onChange={(event) => setForm({ ...form, market: event.target.value })}
                  />
                </label>
              </div>
              <label>
                Objective
                <textarea
                  required
                  maxLength={2000}
                  rows={3}
                  value={form.objective}
                  onChange={(event) => setForm({ ...form, objective: event.target.value })}
                  placeholder="What should this campaign learn or prepare?"
                />
              </label>
              <div className="campaign-mode-choice">
                <label className={mode === "research" ? "selected" : ""}>
                  <input
                    type="radio"
                    name="mode"
                    checked={mode === "research"}
                    onChange={() => setMode("research")}
                  />
                  <span>
                    <strong>Research</strong>
                    <small>Read public pages you add and prepare drafts for your review.</small>
                  </span>
                  <span className="mode-chip">Recommended</span>
                </label>
                <label className={mode === "controlled" ? "selected" : ""}>
                  <input
                    type="radio"
                    name="mode"
                    checked={mode === "controlled"}
                    onChange={() => setMode("controlled")}
                  />
                  <span>
                    <strong>Controlled test</strong>
                    <small>Test-only fixture outcomes. No real external actions.</small>
                  </span>
                </label>
              </div>
              <div className="campaign-zero-spend">
                <ShieldCheck size={15} />
                <span>Starts at zero spend. Publication review is required.</span>
              </div>
              {formError && (
                <div className="campaign-form-error" role="alert">
                  {formError}
                </div>
              )}
              <div className="campaign-modal-actions">
                <button
                  type="button"
                  className="campaign-secondary-button"
                  onClick={() => setDialog(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="campaign-primary-button" disabled={saving}>
                  {saving ? "Creating…" : "Create campaign"}
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
              This pauses {activeCount} active campaign
              {activeCount === 1 ? "" : "s"}. You can resume each campaign from its detail page.
            </p>
            {stopError && (
              <div className="campaign-form-error" role="alert">
                {stopError}
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
    </div>
  );
}
