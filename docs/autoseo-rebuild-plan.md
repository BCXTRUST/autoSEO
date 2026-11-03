# AutoSEO rebuild plan and delivery status

Updated 2026-11-03. Initial repository baseline: `9cae305`. The implementation and evidence sections describe subsequent local work. Release instructions are in [the release runbook](./autoseo-rebuild.md).

Authoritative direction: the user's latest messages require a modern gaming-like UI, direct Anti-Captcha integration, continuous visibility into frontend/backend activity, and intelligent execution that never silently stalls. An older user-supplied handoff informed the workflow but was not confirmed current. Its campaign-specific operational details remain provisional and are intentionally omitted from this public repository document. The initial audit, proposed architecture, implemented scope, test evidence and outstanding live work are distinguished below.

**Current application-release authorization:** On 2026-11-03, the user explicitly instructed: “merge and publish so I can test.” This authorizes the current application release; do not ask the user to repeat that authorization. Root handles Git/publishing, and Astra reviews deploy readiness. This records authorization, not a completed deployment: actual runtime/service ownership, access, backup/restore, migration, and health evidence remain release gates. This authorization does not activate campaigns, enable paid providers, or authorize automatic or unreviewed external contributions.

## Confirmed user direction

- Rebuild the actual tool, including `app.autoseo.run/app` and the public `autoseo.run` site. Environment setup and recompiling the existing application do not satisfy this request.
- Make the product much simpler, with a gaming-style appearance and improved working behavior.
- Integrate Anti-Captcha directly.
- Use Astra for planning, thinking, and review, with a cheaper model for programming.
- Build a reliable link-building campaign workflow: configuration, website analysis, discovery, account preparation, useful contributions, review, execution, and verified results.
- Keep the user informed about what the system is doing, why it is waiting, what it will try next, and what the user can do. Every step must either make progress, recover within defined bounds, or enter an explicit actionable state; no indefinite loading or silent stalls.
- Discover eligible communities/discussions before registration or posting. Track participation requirements, permitted registration/email verification, and relevant contributions. Use truthful identities and claims, respect community rules, and require affiliation disclosure where applicable.
- Use explicit action and spending limits with clear progress and outcomes. Historical volume targets are provisional and do not authorize current throughput or campaign activation.
- Support campaign review, activation, pause/resume, global stop, monitoring, and investigation. Keep paid provider flags disabled by default and require human review before external contributions; application-release authorization does not authorize campaign actions.

## Provisional older campaign details — no current actions authorized by this plan

The older handoff contained pilot campaign identities, website material, market preferences and volume targets. Those operational details were not reconfirmed, were not executed, and are not part of this public plan. Confirm the current pilot, authorized account/site and limits before any campaign scheduling or live action.

## What the supplied handoff covers and what was added

| Requirement | Supplied handoff | Working-plan treatment |
| --- | --- | --- |
| Reliable campaign rebuild and limited pilot | Explicit workflow and acceptance criteria in older handoff | Useful provisional workflow; campaign-specific actions require reconfirmation |
| Simpler dashboard | Explicit states, actionable errors, verified results | Retain and extend |
| Modern gaming-like visual design | Not specified | Explicit requirement from latest user messages; design deliverable below |
| Direct Anti-Captcha integration | Mentioned only as a previously blocked service in verification gaps | Explicit integration workstream and acceptance below |
| Always-visible live activity | Progress/reporting requested, but no persistent live feed specification | Explicit observability requirement below |
| Perfect operation | Not promised; handoff calls out unverified end-to-end behavior | Measurable reliability gates, evidence, and known limitations |
| Automatic external campaign contributions | Explicitly prohibited; external contributions require human review and deliberate action | Constraint retained; separate from authorized application release |

## Modern interface and live activity requirements

- Replace the generic bot-first landing experience with a simpler campaign-first application and a matching modern public site. Use a cohesive gaming-inspired visual system, clear progress and state feedback, restrained motion, readable typography, accessible contrast, keyboard operation, and reduced-motion support. Exact colors and screen compositions remain design decisions to make concrete in a reviewable prototype. XP, leaderboards, and reward economies are not inferred requirements.
- Keep current activity visible throughout normal desktop navigation; provide a compact persistent status and an easily opened activity view on small screens. Show campaign, current step, target site/domain, latest event time, progress, queued work, blockers, and the next useful action.
- Distinguish queued, running, waiting for verification, waiting for human review, retrying, paused, failed, submitted, and independently verified outcomes. Never display a submitted post as a verified live link.
- Persist activity and action results server-side with campaign/job/action correlation. Stream updates with reconnect recovery, deduplicate events, and display disconnected/stale status instead of implying work is live. Reloading or changing screens must preserve history and current state.
- Show plain-language failure reasons and relevant controls: inspect evidence, retry eligible failed work, resolve a blocker, pause/resume, and global stop. User pause and site restrictions must not silently become automatic retries.
- Provide browser evidence or a view of supported active browser work where useful; protect account/session material. Keep credentials, tokens, private mailbox bodies, sensitive browser contents, and raw provider payloads out of normal activity output.

## Intelligent execution with no silent stalls

- Represent every workflow step as a durable state machine. Persist campaign/job/step identity, status, current attempt, lease owner, last heartbeat, last meaningful progress time, next retry time, explicit deadline, checkpoint, outcome evidence, and a structured blocker/recovery reason. Distinguish worker liveness from actual progress: a healthy heartbeat must not hide an operation making no progress.
- Use an independently scheduled watchdog/reconciler to detect expired leases, missed heartbeats, exceeded deadlines, and stalled progress. Perform recovery with transactional ownership checks so competing workers/watchdogs cannot dispatch the same external action.
- Classify failures: transient dependency/network, authentication/expired connection, insufficient funds or limits, unsupported operation/site, eligibility/restriction, invalid input, ambiguous external completion, and permanent failure. Apply bounded retries with backoff only to eligible transient failures; expose attempts and the next deadline in the UI.
- Choose safe supported alternative paths where available, preserve durable checkpoints, and resume from verified progress after restart or user resolution. Alternatives must respect user intent, approval, budgets, and site rules; they must not bypass restrictions, fabricate evidence, or report invented success.
- Use stable idempotency/deduplication keys and persisted external task/action IDs. Reconcile uncertain external results before replay. Where the provider cannot guarantee idempotency, hold ambiguous results for resolution rather than promising exactly-once effects or blindly repeating actions.
- Enter a clear `needs_action`, `blocked`, `paused`, `failed`, or `completed` state when automated progress cannot continue. State the precise blocker, evidence, and useful resolution action; after resolution, resume the appropriate checkpoint. Waiting for email, provider completion, user approval, or credentials must show a reason, timing, and escalation policy rather than indefinite loading.
- Keep the campaign moving across eligible opportunities: give each page/opportunity bounded attempts and an overall time budget. Retry transient failures within those bounds, then persist a deferred outcome with its reason, `retryAfter`, attempts, and checkpoint, and select the next eligible opportunity. One slow or broken page must not block unrelated work.
- Maintain a durable deferred queue and reconsider items when their scheduled retry arrives or relevant prerequisites change. Use per-site circuit breakers and fair scheduling to avoid repeatedly hammering one failing domain or starving other eligible opportunities. Apply site limits and campaign action/spending caps during every selection.
- Distinguish page-specific failures from campaign-wide controls and critical dependencies. A page failure can defer that opportunity; an explicit user pause/global stop or essential campaign-wide authentication failure must stop affected execution rather than be bypassed by selecting another page. Unrelated campaigns may continue where independently authorized.
- If all opportunities are blocked, deferred, exhausted, or ineligible, show an explicit waiting/needs-action state, the reason, and the next scheduled retry or required user action. Sleep until a durable wakeup or prerequisite change; do not spin in an endless busy loop. Moving on is never reported as completing the failed opportunity and does not bypass eligibility, approvals, or site restrictions.
- Make recovery decisions inspectable: what failed, what was tried, why an alternative was selected, and what remains. Internal model reasoning is not required; concise operational explanations and recorded decisions are.
- Provide a campaign command center with the active task, durable timeline, next action, blockers, outcome evidence, attempt/deadline information, and attributable costs. Keep a global pause/stop control accessible. Frontend displays must derive from the same authoritative backend state used by workers and recovery processes.

The requirement is that no step becomes silently stuck. External sites can remain unavailable or require human action; the product must detect this, explain it, stop unsafe repetition, and offer a recovery path rather than guarantee every external action succeeds.

## Direct Anti-Captcha integration requirements

- Integrate the Anti-Captcha API directly from a server-side adapter under a provider-neutral challenge-service contract. Core campaign logic and UI must not import vendor-specific code. Connect actual supported browser tasks to this adapter; a configured key or decorative status card is not an integration.
- Store the provider key using the existing secure configuration/encryption path. Do not expose it to client bundles, model context, API responses, error messages, telemetry, activity events, or test artifacts. Show only configured/connected/error status.
- Verify connectivity and balance before dependent paid work; expose balance and attributable task cost/status safely. Treat low balance, network failure, authentication failure, unsupported challenge type, provider rejection, timeout, and unsuccessful completion as distinct recoverable states.
- Persist internal job linkage and returned provider task IDs. Use bounded polling/backoff, request and overall task deadlines, a maximum retry count, and bounded concurrent tasks. Configure per-campaign/per-day spending and task limits; reserve/check budget atomically before creation.
- Prevent duplicate paid creation on retries/restarts. Reuse a known provider task ID. If creation times out after a request may have been accepted and no recoverable task ID exists, record an ambiguous outcome and stop automatic recreation pending reconciliation; do not assume the provider offers idempotency guarantees.
- On pause/stop, prevent new paid tasks and browser follow-on actions. Account for already submitted provider tasks and charges; do not promise external cancellation or refunds the provider does not support.
- Limit use to authorized workflows and supported sites/challenges, honoring participation/posting restrictions. Unsupported or policy-blocked workflows enter a clear human-review state. This adapter does not override campaign eligibility or publish approval.
- Test with a deterministic emulator for success, low balance, malformed/error responses, polling timeout, retry exhaustion, duplicate suppression, restart recovery, concurrent spending caps, and stop behavior. Include redaction checks. Verify permitted live provider/browser behavior separately and record the evidence and cost.

## Search coverage and evidence (before supplied handoff)

- Read repository `AGENTS.md`, `README.md`, `SETUP_PROMPT.md`, relevant source, package manifests, and the existing setup handoff.
- Examined accessible `/workspace` and `/tmp` file names, including hidden directories; searched repository and scratch/shared/library files for rebuild, product plan, gaming/gamification, and Anti-Captcha terms. Excluded secrets, `.env` contents, dependency/build/cache trees, runtime data, and backups from content searches. Did not read credential files or production/customer records.
- `/workspace/scratch/autoSEO-setup-plan.md` is the only existing planning artifact found. It describes environment onboarding and a Docker test cleanup fix, not a product rebuild.
- `PRODUCT_PLAN.md` and `design/` are both excluded by repository ignore rules and absent on disk. Their names in ignore rules are evidence of intended local/private artifacts, not evidence that their contents were recovered.
- `/workspace/shared/downloads`, `/workspace/library-files`, and the accessible workspace `.codex`/`.agents` directories contain no recovered plan. Temporary files contain setup/build/test logs and runtime caches, not a named rebuild/design artifact.
- Inspected local refs (`work`, `origin/main`), available history (363 commits), relevant commit messages, and history for product-plan/design paths. No tracked plan/design history found. No remote ref refresh or external conversation search was performed.
- `9cae305` changes only `packages/adapters/src/sandbox-conformance.test.ts`: a test teardown correction. It contains no frontend/backend product rebuild.
- At the initial audit baseline, no implementation references to Anti-Captcha or gaming/gamification were found. The managed environment lists `ANTI_CAPTCHA_API_KEY` and the provider API host, but secret readiness is `unknown`; that is configuration evidence, not proof of a working integration.

## Product intent recovered from existing source

The current marketing site (`apps/www/src/pages/index.astro`, `apps/www/src/site.ts`) describes two offers for SEO and GEO. This is historical positioning, not an instruction to expand the supplied handoff beyond its link-building focus:

1. Content: audience/brand brief → topic and keyword research → sourced drafts → human review → scheduled CMS publishing.
2. Links: prospect discovery → live-page qualification → individual outreach drafts → human review → follow-up and placement tracking.

It promises human approval before every publish and send, plus escalation when human judgment is needed. Its workflow counters and preview cards are static marketing examples, not evidence of implemented campaign workflows.

Historical commits `bc12bb6` and `490e7ba` explicitly document the AutoSEO landing positioning. `490e7ba` describes a dub.co-inspired light visual system. That historical landing design does not override the user's newer request for gaming-style UX, and it is not a specification for rebuilding the application.

The app's SEO-specific addition is `packages/core/src/link-building-prompt.ts`, selectable from bot settings in `apps/web/src/pages/Shell.tsx`. It tells a research bot how to use its computer and keep prospect notes. It is not a persisted content/link campaign system.

## Initial architecture and gaps (audit baseline)

| Area | Existing implementation | Rebuild implication |
| --- | --- | --- |
| Public website | Astro in `apps/www`; AutoSEO positioning and application forms | Redesign around actual rebuilt behavior; retain honest early-access/product claims |
| App | React 19/Vite in `apps/web`; `/app` and bot/group routes render `ShellPage` | Replace bot-first entry flow with a simpler product workflow and new visual system |
| Onboarding | Model connection, then “Create your first bot”; welcome still says Rakazo | Reframe around the user's site, goal, and required connections |
| API | Hono/oRPC in `apps/api`, shared schemas in `packages/contracts` | Define explicit product operations and states rather than relying only on chat instructions |
| Storage | Postgres/Prisma in `packages/db` | Existing models are bots, conversations, tasks, runs, routines, computers, etc.; no first-class content/prospect/campaign models found |
| Execution | Graphile jobs, Pi runtime, provider adapters in `packages/adapters` and `apps/worker` | Reuse useful execution primitives behind predictable, recoverable product workflows |
| Approval | Generic action approval rules and external-effect machinery | Verify and enforce product-level publish/send approval with durable records |
| Desktop/mobile | Electron hosts web UI; Expo uses shared API | Preserve compatibility or explicitly scope contract changes; do not silently break these clients |
| Deployment | Separate app/website build paths; website Railway configuration; server image publishing workflow | Verify actual production routing, deployed revisions, and data migration separately from Git pushes/builds |

## Delivery scope and first complete slice

**MVP outcome:** a user creates a campaign for a permitted test website, reviews its factual destination catalog, inspects eligible opportunities, prepares an account including email verification where supported, reviews a useful contribution, authorizes its publication, and sees an independently verified result. All steps appear in the campaign command center. A deliberately broken opportunity is deferred while another completes; a worker restart resumes safely. The direct Anti-Captcha adapter is exercised through a controlled supported challenge fixture and separately through an authorized live integration check before live readiness is claimed.

Use one campaign, one supported community integration, one mailbox integration, and a small opportunity set first. This is a complete vertical slice, not a static UI demo. Build emulators before paid or production services so missing production access does not block implementation.

After this slice works, expand supported sites, richer discovery/ranking, account participation history, reporting, and scale. The historical standalone content/CMS product, billing, competitive rankings integrations, XP economies, and leaderboards are outside the first release unless requested. Public-site claims must reflect delivered capabilities.

## Proposed domain records and invariants

Names below are proposed schema/API names, not claims these records already exist. Keep new files focused and avoid adding all orchestration to the existing large `Shell.tsx` or API router.

| Record | Required content and invariants |
| --- | --- |
| `Campaign` | Workspace/owner, website, goal, language/market, lifecycle, review policy, daily action caps, spend budget, config version, pause version, timestamps. Lifecycle and derived execution health are distinct: an active campaign may be waiting for eligible work. |
| `CampaignSource` / `Destination` | Canonical URL, source snapshot reference/hash, retrieved time, factual claims and provenance, app/shop/article type, review state. A model-generated claim without evidence cannot become an approved claim automatically. |
| `Opportunity` | Canonical site/discussion identifiers, discovery source, relevance rationale, observed rules, eligibility status, participation prerequisites, next action, defer reason/`retryAfter`, terminal outcome. Deduplicate within workspace/campaign using canonical identifiers and explicit account/site scope. |
| `SiteAccount` | Workspace/site/account identity reference, secure credential reference, registration and email-confirmation state, participation requirements/history, last verified state. Registration identity is unique by site and authorized identity, not just by campaign. Reuse across campaigns only when permitted. |
| `ContributionDraft` / `ReviewDecision` | Versioned content, target/account, destination links, source references, disclosure requirements, reviewer and decision. Approval binds a hash of the exact content, destination, account and relevant policy version; material edits invalidate it. |
| `CampaignStep` / attempt | Durable step identity, operation/version, opportunity, status, attempt count, lease fence, heartbeat, last meaningful progress, deadline, checkpoint, retry time, structured failure and resolution. Link to existing `Run` when invoking the agent runtime rather than silently changing existing bot-run semantics. |
| `ExternalAction` | Stable action key, step, approved payload hash, state, submission intent, external ID, result/evidence, ambiguity marker. Reuse/extend existing `ExternalEffect` where ownership and run linkage fit; otherwise introduce a campaign effect table using the same invariant. Do not weaken existing constraints to force a fit. |
| `Publication` | Submission evidence separate from observed live URL, content/link verification evidence/time, status (submitted/pending moderation/verified/unavailable), later recheck result. A removed link remains historical evidence, not an erased attempt. |
| `ChallengeTask` / budget entry | Internal correlation, external provider task ID, status/deadline, reserved maximum cost, actual cost when known, request ambiguity, retry count. Secrets are references, never embedded task/event values. |
| `CampaignEvent` | Workspace/campaign sequence, type/time, correlation IDs, safe summary, state revision, evidence reference. Append transactionally with state changes and retrieve by cursor for reliable replay. |
| Site availability / dispatch intent | Persist circuit-breaker status and next permitted attempt. Persist due work/dispatch intent with the state change; the reconciler repairs missed queue dispatch. Use a compact outbox only if existing transactional queue/reconciliation cannot provide this invariant. |

Add workspace-scoped ownership checks and indexes for due steps, expired leases, waiting opportunities, and event cursors. Enforce important uniqueness and budget reservations in Postgres transactions, not only application checks. Evidence blobs and secrets use existing protected artifact/secret mechanisms with access checks and defined retention.

## Step transitions and scheduler contract

The logical step states are `queued`, `running`, `waiting_external`, `waiting_review`, `deferred`, `needs_action`, `reconciling`, `succeeded`, `failed`, and `cancelled`. Campaign pause is an overriding execution control; show suspended work as paused without losing its underlying checkpoint. Store bounded wait/deadline metadata wherever work is not terminal. `waiting_review` requires a user action and does not retry automatically.

| Trigger | Durable transition and next behavior |
| --- | --- |
| Eligible work is due | Atomically claim lease/fence and budget reservation; recheck campaign control, site eligibility, prerequisites, and approval immediately before dispatch. |
| Transient read failure | Bounded retry/backoff within that opportunity's time budget; record attempt and next retry. Yield the worker between attempts. |
| Budget/time exhausted on one page | `deferred` with reason and `retryAfter`; schedule another eligible opportunity. Permanently unsupported/ineligible work is recorded as such and not endlessly retried. |
| External operation accepted | Persist provider ID/receipt, then `waiting_external` with scheduled bounded polling; no worker held in a long sleeping loop. |
| Timeout during a possible external submission | `reconciling`; inspect remote account/post/task evidence before any retry. If result cannot be determined, `needs_action`. |
| Process crashes / lease expires | Watchdog claims a new fence, checks persisted submission intent and checkpoint; resume read-only work or reconcile side effects. A new lease alone is not permission to replay an external mutation. |
| Prerequisite/user action resolved | Revalidate current approval, limits, and policy, then enqueue the exact safe checkpoint. |
| User pauses/stops | Prevent new dispatch, revoke local ownership where appropriate, cancel supported in-flight read work; track already-submitted external work and reconcile without starting new effects. |
| No eligible work | Explicit campaign waiting state with reason, next scheduled wakeup or user action; no spin loop. |

Maintain a fair round-robin/age-aware selector across eligible campaigns and sites. Apply per-site circuit breakers to repeated transient failures, honor provider/site `Retry-After`, and use a single bounded half-open probe. Never use a new identity/proxy/site route to evade restrictions. Critical campaign-wide credentials block only dependent work; page-local failures do not freeze the campaign.

**Submission boundary:** transactionally persist intent and reserve budget → establish ownership/control checks → execute once → persist receipt or ambiguity → independently verify outcome. Use stable remote idempotency keys when supported. If a request may have succeeded, reconcile before retrying; no generic “retry all errors” wrapper around registration, posting, or paid task creation. Fences prevent stale database writes but cannot by themselves cancel an already-sent remote request. If ownership is uncertain, isolate/terminate the old execution where supported and defer remote mutation until its outcome is known.

**Proposed configurable development defaults:** heartbeat 10 seconds, lease 45 seconds, watchdog interval 15 seconds; read/navigation request deadline 30 seconds; three total transient attempts with jittered backoff between attempts (2 then 10 seconds), and a two-minute active-work budget for one simple page step. Start with one in-flight action per site and conservative campaign concurrency. Provider challenge and email waits have separate finite deadlines based on documented service timing, with durable wakeups instead of consuming the page budget. These are implementation starting values to validate, not claimed production guarantees. Paid work remains disabled until an explicit budget and usable provider configuration exist.

## Frontend and API design

Proposed default visual direction: deep charcoal canvas, crisp luminous cyan/violet accents, clear segmented status cards and a compact command-center layout, restrained motion, and strong readable contrast. This is a concrete design starting point, not a previously approved reference. Status must never depend on color alone. Honor reduced motion and keep controls usable on desktop and mobile.

- `/app` becomes the campaign overview. A campaign view contains Overview, Opportunities, Accounts, Review, and Results; settings remain secondary. A persistent activity rail shows real backend state across these views. On small screens it becomes a fixed compact status strip opening the same timeline.
- Overview answers: what is running, what happened, what is next, what is blocked, and what requires the user's decision. Progress uses actual workflow counts, not invented completion percentages or SEO impact scores. Display costs as known actuals/estimates/reservations distinctly.
- Review shows exact content, account/site, links, supporting sources, applicable rules, and approval controls. Results separate submitted, awaiting moderation, verified live, and unavailable outcomes with evidence.
- Retain old bot/group entry routes as a compatibility/advanced path initially; do not remove existing accounts/history. Electron still hosts the web UI. Additive shared contracts avoid silently breaking Expo clients; mobile product expansion can follow web MVP.
- Extend `packages/contracts` with typed campaign snapshot/CRUD/control/review/recovery/event contracts. Put handlers in focused `apps/api/src/campaigns/` modules and compose them into the router. Use existing auth and scoped repositories. Accept client operation nonces for mutating requests and return authoritative state versions.
- Implement cursor-based campaign event streaming using the existing Postgres fanout + durable replay pattern. Current `ThreadEvents` is thread-scoped; add campaign-scoped storage/contracts rather than misusing a fake chat thread. Notifications are wakeup hints, not the durable event store. Commit the state/event before notification; catch-up polling and reconnect repair missed notifications.
- Load a consistent snapshot plus cursor, subscribe from that cursor, deduplicate sequence numbers, and refresh on a detected gap or expired cursor. Keep disconnected/stale indicators and last-confirmed state visible. Auth failures, reconnect loops, and lost streams must become understandable UI states.
- Provide safe action controls to retry eligible work, resolve a blocker, inspect evidence, skip/defer an opportunity, pause/resume a campaign, and stop all affected work. “Retry” cannot bypass unresolved submission ambiguity or approval invalidation.

## External adapters and model responsibilities

Use existing provider-neutral adapter conventions under `packages/adapter-kit` and `packages/adapters` for discovery, website retrieval, community interaction, email verification, challenge solving, and independent publication verification. Keep site-specific selectors/API translations and compatibility checks outside core scheduling. Each adapter declares supported operations and returns structured outcomes: success, transient failure, blocked prerequisite, unsupported, or ambiguous submission.

Reuse the existing browser/sandbox contracts and AgentMail/connector code only after verifying their behavior fits the supported journey. Email confirmation must correlate to the intended account/request, validate destination and expiry, avoid logging mailbox contents/tokens, and use bounded checks. A missing email defers the account step while other eligible opportunities proceed. Unsupported sites go to review; adding broad browser autonomy does not count as a verified site integration.

The model helps classify relevance, extract sourced facts, understand participation rules, propose useful contributions, and select among supported next actions. It receives bounded tools, visible budgets and deadlines, and evidence references. Core code owns eligibility, limits, approval, state transitions and external-effect authorization. Treat retrieved pages as untrusted input; page instructions cannot grant permissions or reveal secrets. Validate structured outputs, apply bounded correction/retry, and turn missing evidence or invalid output into a recorded blocker. Model or browser narration is never publication evidence.

The engineering model split below is distinct from the product's runtime model selection. Keep production model/provider choice configurable and preserve user credentials; using Luna to write code does not silently change the model customers run.

## Implementation milestones and coding batches

Astra owns architecture, task specifications, difficult decisions, and independent review. Use `gpt-6-luna` for routine, clearly bounded implementation batches. Each batch receives file scope, contracts, acceptance tests, prohibited side effects, and handoff criteria. Security-sensitive execution/approval/migration logic receives detailed Astra design and review; escalate implementation to a more capable coding model if Luna cannot satisfy the tests after focused correction. Do not repeatedly spend cheap-model retries on unresolved architecture.

| Milestone / batch | Scoped implementation areas | Deliverable and gate |
| --- | --- | --- |
| M0: baseline and access map — Astra | Existing app/API/worker/docs; Railway service configuration and domain mappings read-only | Record supported behavior, current revision, data migration inventory, integration prerequisites, app/website service ownership and access gaps. No production state changes. |
| M1a: shared schemas and pure workflow rules — Luna from Astra spec | Proposed `packages/contracts/src/campaigns.ts`, `packages/core/src/campaigns/`, exports | Typed statuses, commands, outcomes, retry classifier, eligibility/approval rules; deterministic transition tests. Astra confirms state coverage and no unbounded retry paths. |
| M1b: persistence and migrations — Luna, detailed Astra review | `packages/db/prisma/schema.prisma`, new migration, focused `packages/db/src/campaigns/` repositories | Additive tables/indexes, scoped queries, transactional budgets/action keys/events. Test old data compatibility and concurrent ownership. No destructive migration. |
| M2: complete fixture workflow — Luna in small sub-batches | `packages/adapter-kit/src/types.ts` and job parsing, proposed campaign executor/adapters, `apps/worker/src/index.ts`, API campaign modules, testkit fixtures | One end-to-end controlled workflow from campaign creation through verified result with basic visible state. No live posting/paid calls. Astra reviews intent/receipt/ambiguity handling before expanding. |
| M3: scheduling and recovery — scoped Luna implementation, Astra ownership of invariants | New campaign scheduler/watchdog and existing `packages/adapters/src/job-reconciler.ts`, background handlers, focused core rules | Retry/defer/next opportunity, circuit breaker, due wakeups, fencing and checkpoints. Fault injection must show progress past a broken page and no duplicate external effects. |
| M4a: direct Anti-Captcha — Luna from reviewed protocol spec | Proposed challenge contract, `packages/adapters/src/anti-captcha.ts`, emulator/tests, environment/config validation, integration status RPC | Actual server-side API adapter and browser connection, redaction, balance/status/errors, reservations and spending cap, bounded polling, ambiguity recovery. Verify provider docs before fixing request schemas or claiming supported challenge types. |
| M4b: first real site/email/model adapters — Luna, one adapter per batch | Focused adapters and existing `apps/api/src/agentmail.ts` / connector integrations where appropriate | Supported registration/email/draft/submission/verification flow with recorded rules and evidence; authorized live check only after needed access and budget decisions. Failure paths remain explicit. |
| M5a: campaign UI primitives and shell — Luna, Astra visual review | `apps/web/src/App.tsx`, proposed campaign pages/components, `packages/ui-tokens`, ported `beautiful-ui` primitives | Gaming-inspired responsive campaign experience and persistent activity frame. Check Beautiful UI source per AGENTS before new primitives; preserve advanced existing routes. |
| M5b: live UI integration and recovery — Luna | Campaign RPC client/hooks/event reducer, API campaign events, DB events/fanout integration | Real snapshots/events, reconnect/gap repair, review controls, evidence and costs, blocked/deferred states. Browser tests include stale stream and resolve/resume. |
| M6: public website — Luna, Astra content/design review | `apps/www/src/pages/index.astro`, components/styles/site metadata and shared tokens where useful | Matching modern site, accurate product walkthrough, accessible responsive layouts, correct app links and no unsupported automation/SEO promises. |
| M7: integrated verification and release packet — Astra checks, Luna focused fixes | Testkit journeys, Playwright, CI targets, migration/rollback runbook | End-to-end evidence, defect closure, deployment map, safe migration and rollback, preview and residual limitations. App release is authorized as recorded below; external campaign posting remains human-reviewed. |

Dependency order: M0 → M1 → M2 → M3; M4 builds on stable M2/M3 contracts. M5 design can begin after M1 contracts, but its functional acceptance requires M3/M4. M6 can proceed after the visual system and actual MVP capabilities settle. M7 integrates all delivered surfaces. Within coding batches, limit simultaneous changes to independently owned files and reconcile shared contracts before integration.

Astra reviews each batch's actual diff, targeted test output, and behavior against its acceptance gate, then gives corrections or accepts it for integration. Avoid treating a model's self-report as evidence. Cross-cutting issues return to architecture before further routine coding. Run the repository's required checks, and if a PR is created, follow AGENTS review/CI completion requirements. This gate is engineering review, not a new request for user permission at each reversible edit.

## Test matrix and required evidence

| Layer | Scenarios | Evidence required |
| --- | --- | --- |
| Pure domain | All valid/invalid transitions, transient vs permanent classification, defer/next selection, circuit breaker fairness, approval invalidation, deadlines/limits | Deterministic tests with controlled time/randomness; no network |
| PostgreSQL integration | Ownership isolation, concurrent claim/budget reservation, unique action keys, event sequencing, migration compatibility | Actual Postgres tests including concurrent workers and stale fences |
| Worker recovery | Crash before/after intent, accepted remote action with lost reply, hung process with healthy heartbeat, lease loss, missed queue notification, all-blocked queue | Fault injection proves reconciliation, bounded progress or actionable wait, no blind replay, no busy loop |
| Provider contracts | Anti-Captcha errors/balance/polling/ambiguity/cost; email timeout/wrong confirmation; unsupported site; model malformed output | Emulators plus redaction tests; live provider results recorded separately |
| UI/browser | Create/configure/review/start/pause/resolve, failed page then next page, approval edit, stream disconnect/reconnect, mobile activity, keyboard/reduced motion | Playwright journeys/screens and manual visual review of the actual rebuilt UI |
| Integrated thin slice | Discovery → rules → account/email → draft/review → authorized test publication → independent verification | Controlled site evidence, durable records, visible timeline, restart during execution |
| Release compatibility | Existing auth/bot routes, Electron web shell, additive Expo contracts, website build and links | Appropriate existing suites/typechecks plus affected-surface smoke tests |
| Authorized live pilot | Actual selected site/provider, paid cost accounting if enabled, production campaign visibility after authorized deploy | Timestamped results and independently verified outcomes; untested flows remain labeled unverified |

Use existing commands and declared tooling: `pnpm lint`, `pnpm check`, `pnpm test`, `pnpm test:integration`, `pnpm test:e2e`, `pnpm build`; run focused tests per batch and broader required checks at integration. Add topology/recovery and Electron smoke checks where changes affect those surfaces. Keep normal CI deterministic/offline; live tests are explicit, scoped, and separate. Do not repeatedly rerun passing unchanged suites without new changes or unresolved concerns.

## Data preservation, deployment preparation, and rollback

1. Inspect current Git and production ownership read-only before choosing deployment targets. Confirm which Railway project/services own the web/API/worker, Postgres, and public Astro site; domains `app.autoseo.run` and `autoseo.run`; deployed revisions; auth/cookie/CORS and `/app` routing; build roots; persistent volumes; and scheduler singleton/concurrency behavior. `apps/www/railway.json`, Compose/Caddy, and image workflows are clues, not proof of live topology or runtime readiness. Ask for missing access only when a dependent live verification requires it.
2. Inventory existing users, organizations, bots, accounts, and campaign-like data without printing private content. Preserve encrypted credentials and histories. Write additive migrations and explicit validated backfill steps; rehearse on synthetic data representing existing schema versions. Reuse existing backup tooling, verify restoration in an isolated environment, and establish retention/access handling.
3. Ship new execution disabled behind a campaign feature/config switch until rollout is explicitly authorized. Do not activate old campaigns automatically, reinterpret old bot tasks as campaigns, or migrate uncertain historical records without a reviewed mapping. Keep compatibility paths during transition; defer destructive cleanup to a later separate migration.
4. Prepare deployment artifacts for app/API/worker and website, health/readiness checks that include schema compatibility and worker/reconciler freshness, and a revision display. Validate service networking and Anti-Captcha/mail/model access separately; configured variables or previous-network results do not prove current connectivity.
5. Release packet contains preview, commit/build identities, migration/backfill procedure, test evidence, supported operations/sites, known limits, rollout order, monitoring, and rollback. The user authorized merge/publishing this application release on 2026-11-03; no further authorization is needed for that same release. Astra reviews deploy readiness and root handles publishing. Do not proceed with production data changes until runtime identity/access and backup/restore evidence are verified. Campaign activation or posting remains separately gated and human-reviewed.
6. After readiness review and verified release gates, deploy compatible schema first and then compatible API/workers/UI in the reviewed order, preserving paid provider flags as disabled. Verify both domains plus the real dashboard. Monitor last worker/watchdog heartbeat, oldest runnable/deferred work, ambiguous actions, error classes and spending; alert when recovery itself stops.
7. Rollback first pauses new dispatch, preserves/reconciles in-flight remote effects, then disables the new feature and returns to known compatible artifacts. Leave additive data intact when rolling back code. Do not restore a database snapshot as a casual rollback: it can erase action receipts and cause duplicate remote effects. Data restoration requires a separate recovery plan with reconciliation of actions that happened after the snapshot.

## Current implementation status

The user explicitly authorized merge and publishing of the current application release on 2026-11-03 so they can test it. This supersedes the earlier request to wait for app-release authorization. No deployment is claimed as completed here. Runtime/service ownership, access, backup/restore, migration, and production health evidence remain unverified gates. Campaign activation, paid providers, and external contributions are separate: paid flags remain disabled by default, and every external contribution still requires human review and explicit action. This status distinguishes implemented code, controlled verification, and unverified external behavior.

- M1a complete/reviewed: campaign contracts and pure scheduling policies; 33 focused tests independently passed.
- M1b persistence/authenticated campaign APIs implemented and reviewed: scoped idempotency, optimistic revisions, consistent snapshots, active additions, resume and recovery controls. Real PostgreSQL and authenticated RPC tests passed, including the conventional disposable-database integration harness.
- M3 actual public-page research and durable worker implemented, with SSRF checks, bounded reads, leases/fencing, watchdog recovery, retry/defer/next-page behavior, and controlled account/email/draft/publication fixtures. Optional real model drafting uses explicit configuration, source-grounded output validation, durable reservation/ambiguity records and shared campaign spending accounting. Focused research/worker tests passed (25), including a successful model response followed by database-write failure with no repeated paid call after restart. Real PostgreSQL verification confirms bounded same-site parking, healthy-site progress beyond the 64-job window and persisted recovery after worker restart.
- M4 direct Anti-Captcha image-to-text adapter implemented (15 deterministic tests), authenticated readiness/manual task API, encrypted results, idempotent paid creation, shared budget accounting and bounded polling. Server reconciliation polls already-created task IDs and expires stale tasks even when the browser closes; its focused tests passed. Real PostgreSQL concurrent reservation/nonce/combined AI-budget test passed. Paid tasks remain disabled by default; automatic site/browser challenge application remains unsupported.
- M5 gaming-inspired campaign dashboard/detail, actual persistent activity, campaign-first signup, configuration, sources, drafts, accounts status, global pause and page recovery controls implemented. Parent's real local Chromium journey passed signup through controlled research/review/edit/reload against PostgreSQL/API/worker. Explicit reviewed Discourse publication/verification controls and database-only live ledger polling are implemented; updated browser assertions passed in the completed controlled campaign harness.
- M6 redesigned public website/supporting pages implemented; Astro checks/build and desktop/mobile visual checks passed. Parent's production build passed all four build tasks. No deployment occurred.
- Actual optional Discourse posting adapter and authenticated durable publication ledger implemented, with human approval, topic validation, bounded automatic anonymous verification of known receipt IDs (manual check remains available), default-disabled posting and no automatic resubmission. Review corrected remote POST replay on transaction retries; an injected commit-failure test checks one POST and durable ambiguity. The real PostgreSQL test passed, alongside campaign persistence and authenticated RPC tests. Live signup/email confirmation remain unsupported pending a chosen platform and authorized account flow; controlled fixtures do not count as live support.
- M7 release/migration/rollback documentation is maintained in `docs/autoseo-rebuild.md`; all three additive migrations were applied only to isolated local databases. Final frozen-source checks passed 20/20 tasks, production builds 4/4, unit tests 1,526 across 196 files (75 tests/18 files skipped by their gates), and lint 625 files with zero errors and six intentional CSS warnings. The earlier complete conventional integration run passed 16 files/74 tests; later interrupted reruns are not passes. Subsequent targeted PostgreSQL verification covered final paid-state recovery, review handoff, serialization, catalog and discovery. All ten original affected browser journeys passed, followed by passing catalog and discovery journeys; the final grounded discovery and controlled campaign browser pair also passed (two tests). Final combined PostgreSQL verification passed six tests across three files in a fresh database after all 36 migrations. The final full conventional integration run passed 77 tests across 16 files. Final affected browser verification passed both controlled and grounded discovery journeys against the actual local API/database/worker. No paid provider calls, live registrations/posts or production deployments were made.

## External work still blocked or unverified

These are outstanding work, not completed milestones or passing-test substitutes:

| Work | Actual blocker or missing evidence | Ready local implementation |
| --- | --- | --- |
| Project catalog and community discovery | Official source content and candidate communities have not yet been inspected; development source/search access is awaiting activation | Automatic bounded catalog, community search/inspection and reviewed candidate selection are locally implemented and verified; live project discovery remains unverified |
| First real registration and email-confirmation journey | An evidence-selected eligible site and its authorized account/mailbox flow must follow discovery | Adapter boundaries, controlled account/email fixture and honest unsupported status |
| Real Anti-Captcha task and site application | Saved key binding is not injected into this runtime; live challenge/site flow not selected | Direct image-to-text API, encrypted manual result, durable budget/idempotency/polling; automatic browser application unsupported |
| Real optional model generation | Model credentials, owner and positive spending/reservation configuration absent | Configurable priced-model adapter, source-grounded review draft and paid-call ambiguity ledger |
| Real reviewed Discourse publication and public receipt verification | Authorized instance/account credentials not present | Default-disabled explicit posting, durable receipt/ambiguity ledger and automatic bounded read-only verification |
| Production release and pilot | Application release authorized 2026-11-03, but Railway/service ownership/access, intended target/revision, and backup/restore/migration rehearsal remain unverified; confirmed project details are kept in a separate local pilot brief | Local builds, additive migrations, reviewable source and release/rollback runbook |

No production deployment, real account registration/email, paid challenge/model request or external publication was performed. M7's live pilot and production validation remain incomplete. Existing keys should be injected into the intended runtime rather than requested again. The project is confirmed separately in a local brief. The tool should discover eligible communities after source access works; the user should not have to pick a platform before discovery. Do not invent candidate sites/accounts or apply unapproved old campaign limits.

## Actionable implementation checklist

- [x] Astra approves the domain/state/recovery design and scoped first integration against current repo behavior.
- [x] Produce a concrete campaign command-center with persistent real-state activity.
- [x] Add shared contracts, additive persistence, scoped APIs, and transactional action/event invariants.
- [x] Complete the controlled end-to-end workflow including synthetic account/email, review/edit/reapproval, local submission, independent fixture verification and terminal work state.
- [x] Demonstrate broken-page retry/defer/next-page behavior and safe restart/ambiguity handling in deterministic faults and real PostgreSQL tests.
- [x] Integrate direct Anti-Captcha with secure configuration, budget controls, durable task tracking and fault tests (live key/task validation remains separate).
- [x] Connect the modern UI and live activity/recovery controls to the durable backend (browser regression evidence recorded below).
- [x] Rebuild the public site to match the delivered product and visual system.
- [x] Complete final changed-backend PostgreSQL and full conventional integration checks after paid-failure, catalog/discovery and grounding corrections; six focused PostgreSQL scenarios and all 77 conventional integration tests passed. Final affected browser pair, repository checks/build/unit/lint and review passed. External live acceptance remains separate.
- [x] Prepare the local builds and migration/rollback release runbook; keep automatic campaign posting disabled. Production backup/restore rehearsal remains a live release gate.
- [ ] After Astra readiness review and evidence of runtime/access/backup gates, root publishes the already-authorized application release and verifies actual behavior; report verified and unverified outcomes precisely. Do not activate campaigns or post external contributions as part of this application release.

## Acceptance evidence map

| Gate | Concrete evidence | Remaining local work / limitation |
| --- | --- | --- |
| Retry/defer selection and no busy loop | `packages/core/src/campaign-scheduling.test.ts`: bounded retries/deadlines, next eligible site, breaker wakeup and deterministic fair ordering | Pure helper tests alone do not prove runtime wiring |
| Worker deadline, stale lease, pause and uncertain paid call | `packages/adapters/src/campaign-worker.test.ts`: hung researcher abort/fence, expired lease recovery, pause during fetch, shared budget and no repeated AI intent | Focused fixture tests, paid-call persistence-failure regression, and actual PostgreSQL multi-opportunity restart/cooldown test passed |
| Real runtime per-site cooldown / move to next page | `packages/adapters/src/campaign-worker.postgres.test.ts`: persisted campaign-scoped cooldown, 70 blocked siblings, healthy-host draft and restart | Implemented, reviewed and passed the real PostgreSQL harness; bounded parking consumes no attempts on blocked siblings |
| Durable owner scope / replay / revisions | `packages/db/src/campaigns.integration.test.ts`, `apps/api/src/campaigns.test.ts` against PostgreSQL | Passed conventional integration harness |
| Concurrent challenge and model accounting | `packages/db/src/campaign-challenges.integration.test.ts` | Passed real PostgreSQL; actual external prices remain estimates/accounting, not provider hard caps |
| No repeated paid model call after persistence failure | `packages/adapters/src/campaign-worker.test.ts`: successful fake model response, failed draft write, preserved reservation/day/cost and one call across restart | Passed; failure transition reads current durable checkpoint under the job fence |
| No blind repeat after uncertain publication | `packages/db/src/campaign-publications.integration.test.ts`: one fake external POST followed by injected commit failure, durable ambiguity | Passed real PostgreSQL; no real external post performed |
| Browser-independent bounded provider reconciliation | `campaign-challenge-worker.test.ts` and `campaign-publication-worker.test.ts` | Focused fake-provider expiry/concurrency/timeout/no-create tests passed; live providers unverified |
| URL and secret boundaries | Research/adapters/service tests cover unsafe URL rejection, bounded responses, sanitized provider failures and encrypted challenge output | No universal website/browser automation claim |
| Activity resume and request lifecycle | `apps/web/src/lib/campaign-data.test.ts` and `campaign-request.test.ts`: overlapping cursor merge, no duplicates, abort old route, serialized refresh | Browser outage/retained-state/reconnect assertions passed; durable activity remains intact |
| Complete controlled workflow and global pause | `apps/web/e2e/campaign-first.spec.ts`: actual local API/DB/worker, synthetic account/email/review/reload | Expanded verified-publication, terminal-job and pause/resume assertions passed |
| Keyboard and render-error recovery | Shared modal keyboard hook and App recovery boundary implemented; actual React throwing-child test passed | Representative browser keyboard/focus assertions passed; no formal accessibility certification claimed |
| Legacy compatibility | Auth, bot CRUD/organization, onboarding connection, golden and group-chat browser specs retained | All 10 affected journeys passed; browser `process` access has a no-Node regression test |
| Deployment / live registration / paid provider / public placement | No live evidence | Explicitly outstanding external work; not part of completed local gates |

## Reliability acceptance gates

These are observable release criteria, not a guarantee that all third-party sites will always work.

- A user can create, inspect, start, pause, resume, and understand a campaign through the new UI; a global stop prevents new side effects. A race test between stop and dispatch verifies that stopped work is not newly dispatched. Already-started external actions are explicitly reported and reconciled.
- Every attempted registration, verification, contribution, provider task, and publication has a durable action record with an outcome or an explicitly unresolved state and recovery path.
- Fault-injection tests cover a hung operation despite continuing heartbeats, missing heartbeat, worker termination, expired lease, dependency outage, Anti-Captcha error/timeout/low balance, delayed or failed email verification, lost provider response, and manual resolution. Every scenario reaches the expected recovery or actionable terminal/waiting state within its configured deadline plus at most one watchdog interval; none remains indefinitely `running`.
- Each step has a declared heartbeat/progress policy, operation deadline, retry budget, watchdog interval, and recovery transition. Tests use controlled clocks to verify boundaries, avoid brittle sleeps, and prove competing recovery attempts do not duplicate external effects.
- A user can resolve a representative blocked step and resume from its recorded checkpoint without repeating previously verified registration, publication, or paid provider creation. The activity timeline shows the failure, recovery decision, resolution, and eventual result.
- A multi-opportunity fault test proves one hanging page exhausts only its own bounded budget, is deferred with a reason and next retry, and allows another eligible page to progress. Verify circuit-breaker behavior, fair scheduling, deferred-queue survival across restart, and wakeup after prerequisite changes. An all-blocked queue enters explicit waiting with no busy loop; user pause and campaign-critical authentication failure are not evaded by moving to another page.
- Worker-crash and replay tests at external-action boundaries produce no duplicate registrations/posts; ambiguous external results are reconciled or held for review rather than blindly repeated.
- Concurrent-worker tests enforce daily action limits and spending limits. Bounded retries/timeouts end with actionable states; no infinite polling, hidden retry storms, or silent stalls.
- Every supported end-to-end journey passes against controlled fixtures/authorized test sites, including email verification, participation restrictions, human approval, failure/retry, restart, and independent live-link verification.
- Review gates apply to the precise destination and content to be executed. Editing either invalidates prior approval where appropriate; a publish/send cannot be triggered solely by an unreviewed model instruction.
- In an automated live-activity test, committed events appear within five seconds on a healthy local/test connection. Disconnects show stale status; reconnect/reload restores durable events and current state without duplicate entries. This is a test target, not a production service-level promise.
- Credential/redaction tests prove secrets do not appear in browser payloads, persisted activity, provider errors, or logs. Workspace ownership checks prevent cross-campaign/account access across tenants.
- Applicable type checks, production builds, domain/API/worker/integration tests, and browser UI journeys pass. Responsive layout, keyboard navigation, contrast, and reduced-motion behavior are reviewed on the rebuilt surfaces.
- Live registration, provider solving, and verified publication are reported as separately evidenced or still unverified. Build/test success is never substituted for real external behavior.
- Following the already-authorized application release, verify the production dashboard shows the intended state and both public/app deployments resolve to the intended revision with a documented rollback path. This verification is outstanding until actual runtime evidence is collected.

## Decisions and nonblocking defaults

Proceed without further clarification on reversible implementation choices: preserve TypeScript/React/Hono/Postgres/Graphile, extend existing packages, use additive migrations, start with a controlled fixture and one supported adapter, keep human review before external publishing, make new paid/live execution opt-in, preserve existing clients, and use the proposed gaming-inspired prototype as a reviewable starting point. No separate user approval is needed for every design detail or local test.

| Decision | When it actually becomes necessary | Work that can continue first |
| --- | --- | --- |
| Discovery-selected community/site + authorized identity/mailbox | Before live registration or posting for that site | Project-source analysis and community discovery once access works; do not require the user to do the discovery |
| Provider/browser configuration, supported challenge type, explicit spending cap | Before paid/live Anti-Captcha verification | Direct API adapter, emulators, secret/redaction and budget tests |
| Current pilot campaign, language/market and throughput | Before creating/altering/activating production campaign state | Generic campaign implementation and synthetic preview; do not assume old pilot details |
| Production service ownership/access and migration constraints | Before production inspection requiring credentials or deployment rehearsal against actual data | Local builds, synthetic migration tests, release instructions |
| Application release | User authorized merge/publishing on 2026-11-03; no repeat authorization required for this release | Astra readiness review; root execution after runtime/service access and backup/restore/migration evidence gates |

The exact visual treatment is a design decision to demonstrate, not a reason to block engineering. Broader CMS/content automation remains later scope unless requested. Missing remote access must be reported precisely while unaffected work continues.

## Plan self-review and definition of done

- **Visibility:** backend states drive frontend snapshots/events; activity remains visible across navigation and reconnect. No mock progress, hidden errors, or invented success.
- **Keep moving:** every operation has finite attempts/time budgets and recovery classification; page-local failure defers and yields to another eligible page. The all-blocked case waits explicitly without spinning. Dead watchdogs/workers surface as unhealthy.
- **Remote uncertainty:** known submission IDs are reconciled; ambiguous accepted requests are not retried blindly. Pausing cannot undo a submitted request, so the UI reports/reconciles it rather than falsely claiming cancellation.
- **Intent and scope:** retry/alternate paths never override pause, approval, cost caps, eligibility, or site restrictions. Older campaign instructions remain provisional.
- **Actual rebuild:** new campaign-first screens, first-class data/workflows, live recovery controls, direct Anti-Captcha, and matching public site must exist and pass the defined journeys. Setup and a green build alone do not qualify.
- **Engineering ownership:** Astra plans and independently reviews/checks; Luna implements bounded routine batches. Risky contracts are specified before code; unresolved architecture is not delegated as guesswork.
- **Release separation:** “implementation complete and ready for review” requires working previews, passed relevant checks, preserved data, and release/rollback artifacts. Application release is authorized on 2026-11-03 but is not complete until root publishes it and actual runtime evidence is recorded. “deployed and live-verified” requires that evidence. Campaign activation and external posting remain separately gated.

The implementation-status section records current evidence. Unchecked acceptance work and external access gaps remain open; local code and controlled tests do not establish production deployment or live-site success.

## Current delivery checkpoint: catalog, discovery and grounded draft review verified locally

- [x] Automatic research Start from the configured website without a manually entered source.
- [x] Persisted per-page jobs, stable website/run identity, 12-page/depth-two limits, canonical deduplication, robots restrictions and observed provenance.
- [x] Bounded SSRF-safe reads; no model drafting, paid calls or contribution creation for catalog pages.
- [x] Real catalog progress, expected optional absence, recoverable page failures and retained history in the UI.
- [x] Configuration changes fence unfinished old-root work; active research queues the new root while paused/draft campaigns remain inactive.
- [x] Four scoped PostgreSQL scenarios passed, covering API/DB lifecycle and actual worker restart/rules/deduplication/cap plus prior 70-sibling recovery.
- [x] Catalog browser journey passed: zero manual URLs, real persisted evidence, blocked-page retry, no false blockers, terminal progress and reload. The controlled campaign journey also passed.
- [x] Provider-neutral search contract, optional no-paid Bing RSS adapter and bounded robots-aware opportunity inspection helper; 18 focused tests passed.
- [x] Automatic discovery wiring: at most three evidence-derived queries and ten unique inspected candidates per catalog run, durable provenance and recoverable failures, no paid drafting during discovery.
- [x] Explicit candidate disposition: **Use for research** queues research for the same candidate under normal model budget gates; **Dismiss** closes it without external effects. Both commands require owner scope, idempotency and stale-state protection. Selection is distinct from site eligibility, account ownership or publication permission.
- [x] Feed up to three bounded verified current-run official sources into the optional drafting contract and matching cost estimate; show available/supplied/missing context and historical references honestly. Preserve context/cost on uncertain paid results, reject stale website identity, and retain review before any external action.
- [ ] Verify actual adapter connectivity after managed network access applies. Built-in Node proxy success does not establish connectivity for the DNS-pinned dispatcher.
- [ ] Live source/community inspection, authorized account/mailbox integration, and paid-provider verification remain subject to the concrete access/configuration dependencies in the runbook. The application release is authorized but not recorded as deployed; runtime/access/backup gates and actual live verification remain outstanding. No live pilot or external contribution is claimed.

Catalog review preserves complete accepted robots policy rather than truncating it, checks restrictions before redirect requests, bounds wildcard work and safely rejects unsupported guidance. Offline tests and local browser success do not establish that any real project website or community has been inspected. Interrupted full test reruns are not counted as passes; the final completed full 16-file/77-test integration run and targeted PostgreSQL passes are recorded separately in the runbook.

Discovery verification checkpoint: all six scoped PostgreSQL scenarios passed across DB/API and worker runs after correcting the recovered-source seeding path. The browser-exposed activity-schema mismatch is fixed with typed event emission and passing snapshot-inclusive PostgreSQL regressions. Catalog and discovery browser acceptance passed against the actual local API/database/worker. Discovery covers failed inspection, explicit retry, selection, source-note draft, dismissal and reload; earlier failed runs are superseded and are not counted as passes. Provider grounding context has 16 focused passing tests; strict context DTO has two passing PostgreSQL scenarios, and UI context/recovery helpers have ten passing tests. Worker grounding integration is frozen with 15 focused tests, adapters type check and Biome passing. It preserves identical quote/dispatch context, validates current website identity before reserving, and retains context and recorded cost on uncertain paid outcomes without another call. Final combined PostgreSQL verification passed six tests across three files; the final full conventional integration run passed 77 tests across 16 files, and final affected browser acceptance passed both controlled and grounded discovery journeys.
