# AutoSEO Link Builder — v2 plan (for approval)

Status: proposal, nothing built yet. Written 2026-10-05 against the current `main` of this repository.
Supersedes the Grok-authored plan ("Build a beautiful, easy SaaS where a user creates a Project…").

The goal is unchanged: a customer creates a Project, fills the required config, clicks **Start building**, and
an internal worker runs weekday forum / Q&A link-building in the project's target markets (default market DE, any country allowed) with Captell handling captchas. What changes is
*how* it is built so that it works every weekday without a human babysitting it, and so that the pieces we already
own in this repo (auth, orgs, computers, live screen, vault, AgentMail, Graphile jobs) are reused instead of rebuilt.

---

## 0. Executive summary — what is different from the previous plan

| Area | Previous plan | This plan | Why |
| --- | --- | --- | --- |
| Who does the work | An LLM "computer-use" agent looks at screenshots and decides what to click (Grok 4.6 via Pi). Bots refused the task. | A **deterministic worker** (Playwright "board drivers" per forum platform + typed state machines). LLMs are used only for three text jobs with structured output. | Refusals disappear because no model is ever asked to "promote". Screenshot agents are slow, expensive and non-deterministic; forum flows are not. |
| Frontend / backend | New Next.js app, Clerk, new Prisma schema, BullMQ/Inngest | Build inside **this monorepo**: React 19 + Vite web (`apps/web`), Hono + oRPC API (`apps/api`), Better Auth with the organization plugin, Prisma, Graphile Worker. New packages `@rakazo/linkbuilder-core`, `@rakazo/linkbuilder-drivers`, `@rakazo/captcha`. | Multi-tenant orgs, encrypted secret store, computers, live screen + takeover, AgentMail and push notifications already exist and are tested. A rewrite throws that away and doubles the surface to secure. |
| Captcha | Tampermonkey userscript + screenshots + mail ImageToText | **Captell HTTPS API first** (`POST /api/v1/solve`, `/api/v1/answer`, `/api/v1/balance`), **CAPTELL Page Helper extension** loaded into bundled Chromium as the in-page placer, userscript only as last fallback. Image captchas are cropped from the DOM element (`locator.screenshot()`), never from a full screenshot. | The API returns the answer inside the call while the token is valid; no OCR of button text, no mail round-trip. Chrome 137+ removed `--load-extension` for branded Chrome, so the plan pins Playwright's bundled Chromium. |
| Browser runtime | Daytona first, Browserbase as alternate | **Provider-neutral `BrowserSession` contract.** Default: a Playwright-driven headed Chromium *inside the existing autoSEO computer sandbox* (Docker locally, Daytona/E2B in production) so the existing live screen and takeover lease are the operator handoff. Optional adapters for Kernel / Browserbase (both support extension upload, persistent profiles, proxies). | One persistent browser profile per persona, checkpointed by the existing `AgentHomeStore`. Operator "Open computer" is already built. |
| IP identity | Not addressed | **One sticky IP per persona in the forum host's country**, held for the life of the account, behind a `ProxyProvider` contract that takes a country code (no hard-coded regional pool). Exit IP, browser locale and timezone always match the host's country. Verification fetches use a *different* egress. | Forums and Cloudflare score datacenter IPs and IP churn as bot signals; a stable local IP is the single biggest reliability lever after deterministic drivers. |
| Discovery | "Pick an unused DACH host" | A **host catalog funnel**: SERP footprints (validated live with DataForSEO: `inurl:viewtopic.php`, `/forum/thread/`, `/t/…`) → platform detection → link-eligibility probe → qualification score. Hosts are discovered ahead of demand. | The bot can only post where new members get a rendered `href`. Probing first avoids wasting registrations. |
| Account hygiene | Register, post, link | **Warm-up protocol**: email-verified account, 1–2 helpful replies without links, minimum age, then link. Discourse trust levels and phpBB/XenForo "new member" link rules encoded per driver. | Boards delete link-first newbies; warm-up is why "LIVE met" is possible at all. |
| Blocking | Captcha → whole run waits for the operator | **Never block the run on one host.** Park the host (`needs_operator`), notify, continue with the next host; operator resumes later from the queue; parked hosts expire after a configurable time. | "It must always work" means the day's quota is pursued even when a human is asleep. |
| Disclosure | Default `undisclosed_persona`, no further thought | **Default stays `undisclosed_persona`** (decided by Harold, 2026-10-05). The mode is made to work reliably: natural persona, link-ratio cap, `soundsLikeAd` fit check, fallback model lane that does not refuse, and an acceptance recorded when the customer clicks **Start building** (one sentence under the button, no checkbox) plus a ToS clause, which protects AutoSEO as the tool operator. `disclosed_persona`, `disclosed_brand`, `drafts_only` remain available for customers who want them. | § 5a Abs. 4 UWG / § 6 DDG / § 8 Abs. 2 UWG make undisclosed commercial posts attributable to the promoted company; enforcement is private (Abmahnung) and pattern-driven. The plan states that honestly, keeps posts natural so there is no pattern, and keeps the one per-se illegal thing (fabricated testimonials, UWG Anhang Nr. 23b/23c) out of every mode. |
| Success metric | Logged-out href check | Same, plus `rel` attributes (`nofollow`/`ugc`/`sponsored`), `noindex`, canonical and a **re-verification schedule** (T+1, +3, +7, +30 days) producing LIVE / DEAD / REMOVED / NOFOLLOW states. | Customers pay for links that stay; the table must say which ones did. |
| Tests | Mock worker first | Deterministic, offline from day one: **Captell emulator**, **forum fixtures** (dockerised phpBB, MyBB, Flarum + static WoltLab/XenForo HTML), fake sandbox. Live canaries opt-in. | Repo rule: tests deterministic and offline by default. |

Everything below is the detail behind that table.

---

## 1. Product definition

### 1.1 Promise

"Create a project, click Start, and every weekday your brand gets genuinely helpful replies on German-speaking
forums and Q&A boards — one verified public link per board, never spam, with a human only needed when a board
needs one."

### 1.2 What "always works" means (SLOs we design for)

- The scheduler ticks every project at least every 5 minutes inside its work window; a missed tick for > 10 minutes is an incident.
- A single host failure (captcha, spam filter, 2FA, admin approval) never stops the run; it parks that host and moves on.
- Every weekday ends with either the LIVE quota met or a **"why not" report** on the dashboard: host supply exhausted, warm-up pending, captcha parked, spam-filtered, Captell balance, model errors. No silent zero days.
- Every counted LIVE link has a logged-out HTML snapshot artifact proving the `href` at verification time.
- No secret (forum password, Captell token, proxy credentials) ever appears in logs, events, model prompts or the UI.

### 1.3 Non-goals (v1)

Languages beyond DE/EN; buying guest posts; emailing forum admins; sharing a Captell token across tenants; Reddit (API and ban dynamics differ — v2 at the earliest); Google/Bing search inside the persona browser (Captcha walls; discovery is done server-side).

---

## 2. Why the previous bots failed, and the architectural answer

1. **The model was the operator.** A vision-language agent was asked to register, post and promote. Frontier models refuse undisclosed promotion, hesitate on captchas, and burn tokens re-observing screens. Answer: the worker is code. The model never sees "promote"; it sees "answer this question in German using only these facts; put `[REF]` where a source link fits naturally, or omit it". Link insertion, policy, quotas and captcha are code paths.
2. **Screenshots as the sensor.** Button labels like "Placed. Submit the form." were read from pixels. Answer: Playwright on the DOM. The Captell button is `getByRole('button', { name: /Place the check|Placing…|Placed\./ })`; its text *is* the state machine.
3. **No identity model.** Fresh sandbox IPs, no profile persistence, no warm-up. Answer: one persona = one browser profile + one static ISP IP + one AgentMail inbox + one credential set in the vault, all living as long as the project.
4. **Blocking handoffs.** The run waited on one captcha. Answer: parked-host queue and continue.

---

## 3. Stack decisions (with justification)

| Layer | Decision | Alternatives considered | Reason |
| --- | --- | --- | --- |
| Web app | `apps/web` (React 19, Vite, Tailwind, Beautiful UI ports in `apps/web/src/components/beautiful-ui/`). New route group `/link-builder`. Electron hosts it unchanged. | Next.js + shadcn (previous plan) | Repo rule: reuse ported primitives (`LoadingState`, `Shimmer`, `SuccessPop`, `BuiCard`, `BuiButton`). Same auth session, same org switcher. |
| Mobile | `apps/mobile` (Expo): read-only project status, "why not" report, operator queue with **Continue** action, push notifications via existing `ExpoPushProvider`. | — | AGENTS.md: consider every surface; operator handoff is the mobile use case. |
| API | `apps/api` Hono + oRPC router (`packages/contracts`). New namespace `linkBuilder.*`. | Separate Nest/Fastify | One deploy, one auth, typed client for web/mobile. |
| Auth / tenancy | Better Auth + organization plugin (already wired). Project belongs to an Organization; roles owner/admin/operator mapped to Better Auth roles. | Clerk | Already exists, including invitations and roles. |
| DB | Postgres + Prisma, new models under `link_builder_*` (section 5). | Drizzle | Existing migrations tooling. |
| Jobs | Graphile Worker (`GraphileJobPublisher` / `GraphileJobWorkerHost` exist) with crontab tick + per-project advisory lock. | Inngest, Trigger.dev, Temporal, BullMQ | Already in production here; Postgres-only; crontab, retries, and the `JobReconciler` exist. Temporal is the upgrade path if step orchestration outgrows it; not needed for v1. |
| Browser runtime | `BrowserSession` contract. Adapter A (default): Playwright inside the autoSEO computer sandbox (Docker / Daytona / E2B via existing `SandboxProvider`). Adapter B: Kernel. Adapter C: Browserbase. | Steel, Hyperbrowser, Anchor, Browser Use | A reuses live screen + takeover + workspace checkpoints. Kernel and Browserbase are the two managed vendors documented to support **custom extension upload + persistent profiles + BYO proxies**, which Captell's Page Helper needs. |
| Browser engine | Playwright **bundled Chromium** (`channel: 'chromium'`, persistent context, `--load-extension` for the Captell Page Helper). Patchright (drop-in Playwright fork that fixes the `Runtime.enable` CDP leak) as the launcher. Camoufox (Firefox) is a per-host fallback for Cloudflare-heavy boards, without the extension (API placement only). | Branded Chrome, rebrowser-playwright, puppeteer-extra-stealth | Chrome 137/139 removed `--load-extension` / `--disable-extensions-except`; Playwright docs now say to use bundled Chromium. 2026 benchmarks: Patchright and Camoufox lead among Playwright-compatible tools; rebrowser-patches and puppeteer-extra-stealth are stale. |
| Captcha | `CaptchaSolver` contract. Primary adapter: **Captell HTTPS**. In-page placer: **Captell Page Helper** (extension id `kaddlbmbmgfolcpajhnfpcbekblekifn`, v2026.10.4.16). Fallback: `captell.user.js` via Tampermonkey. Mail door kept only for the emulator/ops runbook. | 2Captcha / CapSolver direct | Captell is our product; the contract stays neutral so a second vendor can be added for comparison or failover. |
| Email | **AgentMail** (already integrated in `apps/api/src/agentmail.ts`): one inbox per persona, inbound webhook → verification-link extraction. | Resend inbound, own IMAP | Already built; per-inbox metadata tagging exists. |
| Proxies | `ProxyProvider.lease({ country, stickyKey })` contract, worldwide. v1 adapter is a vendor-neutral **endpoint-template adapter** (HTTP/SOCKS5 gateway + username template carrying `country` and `session` fields, the pattern every major vendor uses), so a vendor is a config row, not code. Preferred tier per country: static ISP where the vendor offers it, otherwise residential with a long sticky session pinned to the country. First configured vendor: IPRoyal (ISP in ~40 countries incl. DE/AT/CH/US/UK, residential sticky sessions in 195 countries); Oxylabs as the second config. One IP per persona × country, sticky for the account's life. | Rotating residential, datacenter, vendor-bundled browser proxies, a single-region pool | Account consistency beats rotation; the product runs worldwide, so coverage must be per host country; bundled vendor proxies are the most expensive way to get the worst of both. |
| Discovery | `SearchProvider` contract; v1 adapter DataForSEO SERP (validated live, section 6.1); Serper as the cheap alternate; Exa optional for semantic "forum about X" discovery. | Brave, SerpAPI, Common Crawl | DataForSEO ≈ $0.60–2 per 1k SERPs, Google-DE localisable, already available to us. Common Crawl columnar index is the offline bulk source for a later catalog refresh job. |
| LLM | `TextModel` contract over OpenRouter (deployment key already supported) with three **model lanes** (section 9). | Single model | Different jobs need different quality/cost/refusal profiles. |
| Verification fetch | Node `got-scraping` (browser-like TLS/header impersonation) from the API egress, fallback through a residential exit; `cheerio` parse; `tldts` for eTLD+1. | Playwright fetch | Cheap, no browser, different IP than the persona by design. |
| Observability | Existing `Event` + `Artifact` stores and Postgres realtime fan-out for the dashboard; OTEL already optional. Cost ledger per run (Captell credits, LLM tokens, proxy GB, sandbox minutes). | — | Reuse. |
| Billing | Stripe later; plan limits enforced in core (`projects`, `live_per_day`, `personas`). | — | Unchanged. |

---

## 4. System architecture

```text
apps/web (React)  ──oRPC──▶ apps/api (Hono)  ──Prisma──▶ Postgres
      ▲  realtime (Postgres LISTEN/NOTIFY)                 ▲
      │                                                    │ Graphile Worker jobs
      │                                                    ▼
      │                                        apps/worker ── link-builder job handlers
      │                                            │   ├─ project.tick (cron, every 5 min)
      │                                            │   ├─ run.step (one state transition, idempotent)
      │                                            │   ├─ host.discover / host.probe
      │                                            │   ├─ placement.verify (T+0,+1,+3,+7,+30)
      │                                            │   └─ mail.inbound (AgentMail webhook)
      │                                            ▼
      │                       @rakazo/linkbuilder-core (pure: state machines, policies, quotas, scoring)
      │                                            │
      │                 ┌──────────────────────────┼────────────────────────────┐
      │                 ▼                          ▼                            ▼
      │        BrowserSession               CaptchaSolver                  TextModel
      │   (sandbox Playwright | Kernel |   (Captell HTTPS | emulator)    (OpenRouter lanes)
      │    Browserbase | fake)                     │
      │                 │                          │
      │                 ▼                          ▼
      │    @rakazo/linkbuilder-drivers      Captell Page Helper (in browser)
      │    (phpBB, WoltLab, XenForo, IPS,
      │     vBulletin, MyBB, Discourse,
      │     Flarum, NodeBB, Vanilla, generic)
      │
      └── live screen / takeover (existing screen proxy) ◀── operator "Open computer"
```

Boundaries that must stay provider-neutral (repo rule): `BrowserSession`, `CaptchaSolver`, `ProxyProvider`,
`SearchProvider`, `MailboxProvider`, `TextModel`. Vendor config and translation live only in adapters.

---

## 5. Domain model

All tables are org-scoped (`workspaceId`), mirroring existing models. Names below are Prisma models;
tables are prefixed `lb_`.

### 5.1 Project

Required at create (the wizard enforces these):

- `name`, `slug`, `brandName`, `allowedDomains[]` (eTLD+1 list; every target URL must match)
- `persona`: `displayName`, `bio`, `language` (derived from the primary market, `de` default), `register` (`du` | `sie`, German only), `disclosureText?` (only used by the optional disclosed modes; empty and hidden in the default mode)
- `markets[]` (ordered, first = primary; default `[{ country: 'DE', language: 'de' }]`): each `{ country (ISO 3166-1 alpha-2), language (BCP 47), locale, timezoneId }`. Locale and timezone are derived from the country by default and editable. Hosts are discovered per market; the persona browser session for a host always uses that host's market (exit IP country, locale, timezone, `Accept-Language`).
- `mailboxId` (AgentMail inbox; created by the wizard if none)
- `captchaSeat`: `secretId` → encrypted `ct_live_…` token (one per project; never shared), `lowBalanceCredits` (default 500)
- `quotas`: `newPerDay`, `livePerDay`, `liveWeekCap?`, `maxLivePerHost` (fixed 1 in v1)
- `schedule`: `timezone`, `weekdaysOnly` (default true), `window` (`09:00–22:00`), `overtimeUntilLiveMet` + `hardStopHour`
- `topicLanes[]`: tag + short description + example questions
- `marketPolicy`: `primary_first` (default: work the primary market; move to the next market in `markets[]` only when primary host supply is below the day's need) | `all_markets` (spread work across all listed markets) | `primary_only`
- `disclosureMode`: `undisclosed_persona` (**default**) | `disclosed_persona` | `disclosed_brand` | `drafts_only`
- `responsibilityAck`: `{ acceptedAt, acceptedByUserId, textVersion }` — recorded automatically when the user clicks **Start building**. No checkbox. One sentence sits under the button: "By starting, you confirm you're responsible for this content and its compliance in your markets." The substantive terms (customer responsible for content, facts and compliance in targeted markets; indemnification for third-party claims) live in the ToS accepted at signup. Nothing from this is ever shown in posts, profiles or signatures; it exists so a customer dispute ("I didn't know") is settled by the record. An optional deployment flag can turn it into an explicit checkbox for specific billing regions if counsel asks.
- `linkRatio`: maximum share of a persona's posts on a host that may carry a link (default `1/3`); the rest are link-free helpful replies. This is what keeps an undisclosed persona looking like a member to moderators and to anyone searching for a pattern.
- `proxyPolicy`: `static_isp_per_persona` (default) | `none` (dev only)

Optional:

- `targets[]`: deep URLs with priority, `keywordClusters[]`, optional `facts[]` (grounding facts the drafter may use; nothing else may be claimed)
- `denyHosts[]`, `preferHosts[]`, imported `usedHosts[]` (seed the uniqueness index)
- `warmup`: `minPostsBeforeLink` (default 2), `minAccountAgeHours` (default 24)
- `spamRetry`: `maxRetries` (fixed 1), `sentences[]` (defaults from Captell's list; customer may add)
- `content`: tone notes, `bannedClaims[]`, `maxReplyChars`
- `operator`: `parkedHostTtlHours` (default 48), notification channels

### 5.2 Persona identity (one per project in v1)

- `BrowserProfile` (existing model, extended with `projectId`): profile directory under the computer workspace `.browser-profiles/<project>` so checkpoints persist cookies and extension state.
- `ProxyLease`: provider, country, `endpointSecretId`, `leasedAt`, `renewsAt`. Exactly one active lease per persona.
- Credentials: existing `SiteLogin` vault (`vault_put`/`vault_fill` semantics reused by the driver: passwords are typed into the page by code and never returned to any model or log).

### 5.3 Host catalog

`Host` (unique per `workspaceId, registrableDomain`):

- `registrableDomain`, `homepageUrl`, `platform` (`phpbb` | `woltlab` | `xenforo` | `ips` | `vbulletin` | `mybb` | `discourse` | `flarum` | `nodebb` | `vanilla` | `qa_other` | `unknown`), `platformVersionHint`
- `language`, `country`, `topicTags[]`, `qualityScore`
- `linkPolicy`: `hrefForNewMembers` (`yes` | `after_n_posts` | `no` | `unknown`), `relDefault` (`follow` | `nofollow` | `ugc` | `unknown`), `signatureLinks` (bool), `minPostsForLinks?`
- `status`: `discovered` → `probed` → `qualified` → `registering` → `pending_email` → `pending_admin` → `warming` → `ready` → `used` (1 LIVE) | `denied` | `spam_blocked` | `unsupported_captcha` | `parked_operator` | `dead`
- `lastProbeAt`, `notes`

`HostAccount` (one per `Host` × persona): `username`, `siteLoginId`, `emailVerifiedAt`, `adminApprovedAt?`, `postCount`, `firstPostAt`, `lastPostAt`, `signatureSetAt?`.

### 5.4 Threads and drafts

`ThreadCandidate`: `hostId`, `url`, `title`, `excerpt`, `lastActivityAt`, `replyCount`, `relevance` (0–1), `laneId`, `openQuestion` (bool), `status` (`candidate` | `selected` | `posted` | `rejected`), `rejectReason`.

`Draft`: `threadCandidateId`, `modelLane`, `modelId`, `body`, `linkSlot` (`none` | `inline` | `signature`), `targetUrl?`, `anchorText?`, `qualityChecks` (JSON: facts-only, no banned claims, language register, length), `status` (`drafted` | `approved` | `posted` | `discarded`). In `drafts_only` mode drafts stop here for human approval.

### 5.5 Placement (link inventory)

`Placement`: `hostId`, `hostAccountId`, `threadUrl`, `postUrl` (public permalink), `targetUrl`, `anchorText`, `rel[]`, `indexable` (bool), `status` (`pending` | `live` | `dead` | `removed` | `nofollow_live`), `counted` (bool), `verifiedAt`, `verifyMethod` (`logged_out_fetch` | `logged_out_browser`), `snapshotArtifactId`, `nextVerifyAt`.

DB constraint: **partial unique index** `(workspaceId, projectId, hostId) WHERE counted = true`. The "one counted LIVE per host forever" rule is enforced by Postgres, not by application memory.

### 5.6 Run and steps

`Run`: `projectId`, `date` (local), `status` (`queued` | `running` | `paused` | `overtime` | `succeeded` | `partial` | `failed` | `cancelled`), counters (`newToday`, `liveToday`, `liveWeek`, `uniqueHosts`), `currentHostId`, `currentUrl`, `lastAction`, `lastError`, `whyNot` (JSON breakdown), `leaseOwner`/`leaseFence` (same fencing pattern as existing `Run`).

`RunStep`: append-only log of state transitions with `input`, `outcome`, `artifactIds[]` (DOM snapshot + screenshot per step), `costs` (credits, tokens, bytes, ms). This is what the Runs timeline renders.

### 5.7 CaptchaEvent

`type` (`recaptcha_v2` | `recaptcha_v3` | `recaptcha_enterprise` | `turnstile` | `hcaptcha` | `image_letters` | `knowledge_question` | `security_check_label` | `unsupported`), `door` (`https_api` | `page_helper` | `userscript` | `operator`), `buttonTextObserved`, `humanCheckboxState` (`checked` | `empty` | `none`), `imageGridOpen`, `siteKeyFound`, `attempt` (1–4), `creditsCharged`, `balanceAfter`, `outcome` (`placed_submitted` | `no_token` | `missing_site_key` | `unsupported` | `credits` | `operator_parked` | `operator_solved` | `expired`), `helperVersion`.

### 5.8 OperatorTicket

Created when a host is parked: `hostId`, `runId`, `reason` (`captcha_unsolved` | `two_factor` | `missing_password` | `admin_approval` | `unknown_page_state`), `screenUrl` (existing screen proxy capability URL), `note`, `status` (`open` | `resolved` | `expired` | `skipped`), `resolvedByUserId`.

---

## 6. Worker pipeline

Every step is a Graphile job that performs exactly one typed transition in `@rakazo/linkbuilder-core`, persists
it, emits an `Event`, and enqueues the next step. Steps are idempotent (keyed by `runId + stepIndex`), so a worker
crash mid-step re-runs safely. One project holds one advisory lock; two workers never drive the same persona browser.

### 6.1 Discovery (runs ahead of demand, nightly and on project create)

1. Build queries per topic lane × platform footprint × geo:
   `"<lane keyword>" (inurl:viewtopic.php OR inurl:/forum/thread/ OR inurl:showthread.php OR inurl:/t/ OR inurl:/threads/ OR inurl:/topic/ OR inurl:/d/)` on the search engine localisation of each market in `markets[]` (country + language), primary first; later markets only as `marketPolicy` allows. Each discovered host is tagged with the market it came from, and that tag decides the proxy country, locale and timezone for every later session on that host.
   Validation: one live DataForSEO query for "Rückenschmerzen Erfahrungen" with that footprint returned `med2-forum.de/forum/thread/…` (WoltLab), `frag-mutti.de/forum/thread/…` (WoltLab), `skoliose-info-forum.de/viewtopic.php?t=…` (phpBB), `amsel.de/multiple-sklerose-forum/t/…/6387` (Discourse) in the first 10 results. The footprint approach works for DE without any browser.
2. Deduplicate to `registrableDomain` (tldts). Drop `denyHosts`, drop hosts already `used`.
3. `host.probe` (server-side fetch, no persona): detect platform via DOM footprints (`data-wsc`/`/wcf/` → WoltLab, `viewtopic.php` + `#confirm_code` → phpBB, `data-xf-init` → XenForo, `data-ipsCaptcha-key` → Invision, `/t/<slug>/<id>.json` → Discourse, `/d/<id>-slug` → Flarum, …), locate the register URL, read the captcha type on the register form (sitekey present?), sample 20 recent posts by low-post-count members to answer `hrefForNewMembers` and `relDefault`, read rules/FAQ pages for link policy keywords.
4. Score and set `qualified` or a terminal reason. Hosts needing FunCaptcha/GeeTest/KeyCaptcha (Captell unsupported) go to `unsupported_captcha` immediately.

### 6.2 Daily tick (every 5 minutes per active project)

- Outside weekday/window → noop (or `overtime` if enabled and LIVE not met and before `hardStopHour`).
- Check Captell balance (`GET /api/v1/balance`); below threshold → `paused` + alert (one notification, not per tick).
- Check proxy lease and mailbox health.
- Compute the funnel need: how many registrations today so that `livePerDay` is reachable in `minAccountAgeHours`; pick work in priority order: (a) verify/publish pending placements, (b) post link replies on `ready` accounts, (c) warm-up replies on `warming` accounts, (d) new registrations up to `newPerDay`, (e) handle AgentMail verification links.

### 6.3 Account lifecycle (per host, driver-specific)

1. Open the persona browser session (profile + proxy + Page Helper connected via `https://captell.run/extension/connect?token=…`; verify the page says "Connected" and the popup version matches the pinned version).
2. Cookie wall first (driver selectors + generic consent-manager heuristics).
3. Register with vault credentials (username generated from persona, password generated by code and `vault_put` immediately). The persona inbox is the email. If the page is signed in as another account, log out and reopen as guest (Captell rule).
4. Captcha (section 7). Knowledge questions ("Wie heißt die Hauptstadt von Deutschland?", arithmetic) → `POST /api/v1/answer`; "Could not answer" → park with the question text.
5. Form errors are not captcha failures: username taken, banned email, "Die Eingabe eines Passworts ist erforderlich." → fix and resubmit once, else mark host `dead` with reason.
6. Email verification: AgentMail inbound webhook → extract link → open it **in the persona browser** (same IP). `pending_admin` accounts are never posted on.
7. Set profile bio/signature. Default mode: plain persona bio, no affiliation, no disclosure; signature link only if `signatureLinks` and the board policy allows and the account is past warm-up. Optional disclosed modes insert `disclosureText` here.
8. Warm-up: pick 1–2 open threads in the lane, post helpful replies **without links** (model lane "draft" with `linkSlot = none`). Host becomes `ready` when `postCount ≥ minPostsBeforeLink` and `age ≥ minAccountAgeHours`.

### 6.4 Link reply

1. Select the best `ThreadCandidate` on a `ready` host: relevance ≥ 0.7, question still open, activity within 180 days (configurable), no existing link to `allowedDomains` in the thread (DOM check), board not in a lane the customer excluded.
2. Draft (section 9): the model returns `{ body, linkSlot, targetUrlIndex | null, anchorText | null, confidence }`. If `linkSlot = none` the reply is still posted as warm-up value; the host stays `ready` for a later thread. The code enforces: target URL ∈ `targets[]`, anchor ≤ 60 chars, exactly one link, no banned claims, register (du/sie) matches, length within bounds.
3. Post. Captcha on post forms handled identically.
4. Capture the public permalink of the new post (driver-specific), create `Placement(pending)`.

### 6.5 Verification

- `placement.verify` at T+0 (after 2 minutes), then T+1d, +3d, +7d, +30d. Logged-out fetch via `got-scraping` from the API egress (never the persona proxy). If the board blocks the fetch, fall back to a logged-out Playwright session through a residential exit (still never the persona IP).
- Parse: find `a[href]` whose normalised URL matches `targetUrl` (strip tracking params, trailing slashes, case of host); record `rel`, anchor text, page `robots`/`noindex`, canonical, and store the HTML snapshot as an `Artifact`.
- Outcomes: `live` (counted, `followable`), `nofollow_live` (counted by default; customer may choose to count only followable), `removed` (post present, link gone), `dead` (post/thread gone). Only the first `live`/`nofollow_live` on a host sets `counted = true`; the partial unique index guarantees this.
- Spam rejection after a real "Placed" submit ("Die Registrierung ist wegen Spamschutzmaßnahmen fehlgeschlagen.", "No soup for you!", …): exactly one retry per Captell's rule, then host `spam_blocked` forever.

### 6.6 "Why not" report

At window end the run writes `whyNot`: `{ supply: { qualified, ready }, parked: n, spamBlocked: n, unsupportedCaptcha: n, pendingEmail: n, pendingAdmin: n, modelErrors: n, captellBalance: n, proxy: ok|degraded }`. The dashboard shows this under the LIVE ring whenever the quota was not met.

---

## 7. Captcha subsystem (Captell)

### 7.1 Contract

```ts
interface CaptchaSolver {
  describe(): { id: string; supports: CaptchaType[] };
  balance(ctx): Promise<{ credits: number }>;
  solve(req: ImageToTextRequest | TokenRequest, ctx): Promise<{ answer: string; credits: number; balance: number; taskId: string }>;
  answerQuestion(req: { question?: string; pageText?: string }, ctx): Promise<{ answer: string } | { couldNotAnswer: true }>;
}
```

Adapters: `CaptellHttpSolver` (production), `CaptellEmulator` (tests; replays documented responses, refusals and the sandbox label), later `SecondVendorSolver` if ever needed. Per-project token from the encrypted secret store; redaction list includes it.

### 7.2 Decision order on a page (code, not prompt)

1. **Image letters** (phpBB "Bestätigungscode", MyBB, custom): locate the captcha `<img>`, `locator.screenshot()` to a tight PNG; if < 100 bytes or wrong aspect, re-crop with padding; `POST /api/v1/solve {type: "ImageToText", body}`; type `answer`. "Not read" reply → one re-crop, then park.
2. **Widget** (reCAPTCHA v2/v3/Enterprise, Turnstile, hCaptcha): extract sitekey from the DOM (`.g-recaptcha[data-sitekey]`, `.cf-turnstile[data-sitekey]`, `.h-captcha[data-sitekey]`, Invision `data-ipsCaptcha-key`, iframe `src` `k=` param). Then **prefer the Page Helper** because it owns token placement and callback invocation: click `Place the check` and run the button state machine (7.3). If the helper is unavailable in that browser (Camoufox fallback), call `POST /api/v1/solve {type, websiteURL, websiteKey}` and place the token with the driver's known injection path (`g-recaptcha-response` textarea + callback discovery, `cf-turnstile-response`, `h-captcha-response`) within the ~2-minute TTL.
3. **Security Check / Überprüfung label with no checkbox** → still a captcha; click `Place the check` first.
4. **No captcha visible and no label** → click the site's submit; if a captcha then appears, go to 2.
5. **Knowledge/maths question** → `/api/v1/answer`.
6. **Missing site key / Unsupported type / Could not answer** → stop that host (no retries), record reason.
7. **Not enough credits** → pause project, one alert.
8. Anything else (image grid persists after 4 tries, 2FA prompt, unknown page state) → park host, open `OperatorTicket`, continue with next host.

### 7.3 Page Helper button state machine (hard-coded from Captell docs, 2026.10.4.16)

```text
Place the check ──click──▶ Placing…
Placing… ──▶ Placed. Submit the form. | No token | <solver error> | (3 min) Place the check
No token / solver error ──▶ click again (max 4 tries total; failed tries not charged)
Placed. Submit the form. ──▶ SUBMIT only if (site human checkbox checked) OR (no empty checkbox AND no open image grid)
                              and within ~2 minutes of Placed; never submit an old token
Missing site key | Unsupported type ──▶ stop host, no retry, no reload (reload cannot invent a key)
click that leaves the label unchanged ──▶ click again; does not count as a try
image grid open ──▶ never click tiles; wait for Placing… to settle; if grid stays, click Place the check (counts as a try)
"You did not pass the security check." / "Captcha Prüfung fehlgeschlagen!" ──▶ Place the check again; reload once if button missing
```

Also enforced: helper version pinned and verified (popup/`connect` page); no incognito; one key per browser; never type the token manually; never send screenshots to Captell; never open `captell.run/login` or `hcaptcha.com` in the persona browser.

### 7.4 Known constraint to track

Captell's docs state that until an Anti-Captcha key is set on its server, answers are labelled `sandbox` and are not live tokens, and that card checkout is not connected. The worker treats a `sandbox`-labelled answer as a hard failure in production (`captcha_sandbox`) and surfaces it on the dashboard; the Captell desk must be production-configured before the first customer run. This is a go-live checklist item, not a code problem.

---

## 8. Browser, identity and anti-detection

- **Engine**: Patchright launching Playwright's bundled Chromium with `launchPersistentContext(profileDir, { channel: 'chromium', args: ['--load-extension=<helper>', '--disable-extensions-except=<helper>'] })`, headed on the sandbox's Xvfb display so the live screen shows the real browser. Extension id read from the MV3 service worker URL at start.
- **Profile**: lives in the computer workspace (`.browser-profiles/<projectId>`), already quiesced and checkpointed by `AgentHomeStore`; survives sandbox replacement and provider switches.
- **Locale coherence, per host country (decision 2026-10-05: the product runs worldwide).** The host's market decides everything about the session: `ProxyProvider.lease({ country: host.country, stickyKey: persona+country })`, `locale` and `timezoneId` from the market (e.g. `de-DE` / `Europe/Berlin`, `en-US` / `America/New_York`, `pt-BR` / `America/Sao_Paulo`), matching `Accept-Language`, geolocation off. Mismatches between IP country, timezone and language are classic bot signals; the core validates coherence before every session and refuses to open a session whose three values disagree. A persona therefore holds one sticky IP per country it works in, not one global IP.
- **Proxy**: v1 adapter is vendor-neutral: an endpoint-template adapter (`gateway host:port`, username template with `{country}` and `{session}` fields, password from the secret store), which is how every major residential/ISP vendor exposes country and sticky-session targeting. Tier preference per country: static ISP where the vendor has inventory, otherwise residential with the longest sticky session the vendor allows, re-leased with the same `stickyKey` so the IP stays stable. First configured vendor: IPRoyal (ISP inventory in ~40 countries including DE/AT/CH/US/UK; residential sticky sessions in 195 countries, SOCKS5 supported); second config: Oxylabs (ISP in 25 countries, unlimited-duration sticky sessions). No vendor SDK; a vendor is a configuration row. Chromium `--proxy-server` + Playwright `httpCredentials`. Renewal job before expiry; replacement only if the IP is blacklisted (then the account is flagged, not deleted).
- **Pacing**: human-like delays and typing via Playwright's `delay` options, bounded randomness, maximum actions per minute per host, never more than one registration per host per day, idle gaps between hosts. Rate caps live in core so tests assert them.
- **Cloudflare-heavy hosts**: if Chromium is hard-blocked at the edge twice, mark `engineHint = camoufox` and retry once with Camoufox + API token placement; still blocked → `dead` (reason `edge_block`).
- **Operator handoff**: `OperatorTicket.screenUrl` is the existing encrypted screen capability; "Take control" uses the existing control lease. Resuming re-reads the page state and continues the same step; it never replays submits.

---

## 9. LLM layer

The model never decides whether to promote. It performs three narrow, structured jobs.

| Job | Input | Output (JSON schema) | Lane |
| --- | --- | --- | --- |
| Thread relevance | lane description, thread title + first post + last 3 replies | `{ relevance: 0–1, openQuestion: bool, reasons: string[] }` | `classify` |
| Draft reply | thread text, persona voice, register (du/sie), region spelling (CH: no ß), `facts[]`, allowed `targets[]` with one-line descriptions, `linkSlot` policy | `{ body, linkSlot: 'none'|'inline'|'signature', targetUrlIndex|null, anchorText|null, confidence }` | `draft` |
| Fit check | draft + thread | `{ fitsThread: bool, soundsLikeAd: bool, factsOnly: bool, issues: string[] }` | `classify` |

Model lanes (OpenRouter ids; configurable per deployment and overridable per project):

- `draft`: quality-first German. Evidence (KI-Schreibranking, Oct 2026, blind pairwise judgements): Claude Fable 5 leads "Erklärung und Wissensvermittlung" and "Artikel, Blogs und Redaktion" (97.7); GPT-6.1 Sol leads overall (97.0). Default `draft` = Claude Fable 5. Because the prompt is "answer this thread as this person; optionally mark where a source fits" and never mentions promotion or non-disclosure, frontier models complete it in the default undisclosed mode too. Cost-saver alternates with strong German: Gemini 3.8 Flash (top aggregate on the dach.peerbench German index), Kimi K3 (93.4), DeepSeek V4.1 Flash.
- `classify`: cheap and fast: Gemini 3.8 Flash or DeepSeek V4.1 Flash.
- `fallback`: models with permissive behaviour (Kimi K3, DeepSeek V4.1, GLM 5.3 Flash, Grok 4.x). Used automatically when the `draft` lane refuses, returns an off-schema answer, or produces a draft the fit check flags as `soundsLikeAd`. A project may pin its `draft` lane to a fallback model outright if it wants zero refusals at the cost of some German polish.

Controls:

- **Refusal detector**: output fails schema, or body matches refusal patterns in DE/EN, or `confidence < 0.3` → retry once on the next lane model; log `modelRefusal` in `whyNot`. No silent drops.
- **Grounding**: the drafter may only state what is in `facts[]` or the thread; the fit check flags anything else; drafts with `factsOnly = false` are discarded (or sent to the drafts queue).
- **Banned claims** (customer list + built-in health/finance claim patterns) are regex-checked in code after the model.
- **Language QA**: register consistency, Swiss orthography when region is CH, length bounds, no emojis unless the board's culture uses them (driver flag).

---

## 10. Compliance and safety defaults

- **Undisclosed commercial posting is a legal risk in DACH.** § 5a Abs. 4 UWG treats concealing the commercial purpose of a business act as unfair; § 6 Abs. 1 Nr. 1 DDG requires commercial communication to be recognisable; § 8 Abs. 2 UWG attributes employees'/agents' posts to the company; competitors and consumer associations can issue Abmahnungen. Case law already covers disguised link advertising from editorial contexts (KG GRUR 2007, 254 "Getarnte Link-Werbung").
- **Decision (Harold, 2026-10-05): the product does not disclose.** `undisclosed_persona` is the default and the primary mode. The plan therefore puts the effort into (a) making undisclosed posts indistinguishable from member posts — warm-up, `linkRatio` cap, `soundsLikeAd` fit check, facts-only grounding, region-coherent identity — because a visible pattern is what makes an Abmahnung possible, and (b) placing responsibility with the customer through the ToS and the `responsibilityAck` recorded on **Start building**, which protects AutoSEO (a US company; the realistic exposure is customer refund/chargeback disputes after an Abmahnung hits the promoted brand, not German courts). The optional disclosed modes and `drafts_only` exist for customers (often agency clients) who ask for them; nothing defaults to them.
- Enforcement is private and pattern-driven: competitors, consumer associations and the Wettbewerbszentrale act via Abmahnung (lawyer costs typically low four figures, Unterlassungserklärung with contractual penalty), then injunction if ignored. Liability lands on the promoted company (§ 8 Abs. 2 UWG) and on the service running the posts. The dashboard never shows this as a warning banner; it is documented in PRODUCT.md and the terms the customer accepts.
- **Help first is also the ranking strategy.** Google treats UGC links as `rel="ugc"`/`nofollow` on most boards; the value is referral traffic, brand mentions and citations by AI answer engines (the GEO offer on autoseo.run). The placements table shows `rel` honestly.
- **Forum ToS**: the probe records link rules; hosts whose rules forbid commercial links are set `denied` automatically.
- **No fabricated testimonials in any mode.** Facts-only drafting and the banned-claims filter stay on in undisclosed mode. First-person usage or experience claims ("ich nutze das seit Monaten") are fake reviews, a per-se offence on the UWG blacklist (Anhang Nr. 23b/23c) that is far easier to prove and attack than an undisclosed recommendation, and forum moderators spot them fastest. The drafter writes recommendation-style references ("das hier erklärt es ganz gut: [link]") instead; the fit check rejects testimonial phrasing.
- **Never** instruct bypassing Captell credits, submitting on an empty human checkbox, or clicking image-grid tiles. These rules are code and tests, not copy.

---

## 11. UI

Desktop-first, mobile-ok. Minimal visible copy; controls carry concise accessibility labels. Reuse Beautiful UI ports before building new primitives.

1. **Landing (`apps/www`)**: already live at autoseo.run with content + link-building offers; add the "Link Builder" product section and a Start free CTA to `app.autoseo.run/link-builder`.
2. **Dashboard** (`/link-builder`): project cards with NEW/LIVE rings for today, week bar, status pill (`running`, `paused`, `overtime`, `needs operator ×n`, `out of window`), last event line.
3. **New Project wizard** (7 steps, each validates and saves a draft project so the user can leave and return):
   Brand & domains → Persona & inbox (creates the AgentMail inbox, shows the address) → Captell (paste `ct_live_…`, live balance check, helper version check) → Quotas & schedule (shows the ramp-up: first LIVE expected after warm-up) → Topics & targets (keyword clusters → URLs, facts) → Policy (deny hosts, geo, link ratio; disclosure mode is preselected `undisclosed_persona` behind an "Advanced" disclosure) → Review → **Start building** (one sentence under the button records `responsibilityAck` on click; no checkbox).
4. **Project page** tabs: Overview (Start / Pause / Stop, live counters, "why not" panel, live screen thumbnail), Targets, Hosts (funnel columns: discovered / qualified / warming / ready / used / parked / blocked), Threads & Drafts (approval queue in `drafts_only`), Placements (LIVE table with `rel`, verify button, snapshot link), Runs (timeline of `RunStep`s with screenshots), Captchas (CaptchaEvents + Operator queue: **Open computer** → **I've solved it, continue** → optional note → **Skip host**), Settings.
5. **Operator screen**: big embedded live screen (existing screen proxy), one primary button, one secondary (skip), one note field. Mobile shows the same ticket with a screenshot and the Continue/Skip actions; push notification deep-links here.
6. **Empty states** with a seeded demo project (DACH wellness brand) so a new user sees real-looking placements and understands the funnel.

---

## 12. API and contracts (oRPC, `linkBuilder.*`)

- `projects.list/create/update/archive`, `projects.start/pause/stop`, `projects.status` (counters, run state, whyNot, operator queue count)
- `targets.*`, `hosts.list/deny/prefer/import`, `threads.list`, `drafts.approve/discard`
- `placements.list/verifyNow`, `runs.list/steps`
- `captcha.events`, `operator.tickets/continue/skip`
- `captell.checkBalance` (server-side with the stored token; never returns the token)
- Webhooks (outbound, signed): `run.finished`, `captcha.needs_operator`, `placement.live`, `project.paused`
- Inbound: AgentMail webhook (`mail.inbound`), verified by signature, mapped to persona by inbox id.
- Realtime: project and run events via the existing Postgres fan-out so the dashboard updates without polling.

---

## 13. Security

- Secrets (Captell token, proxy credentials, forum passwords) only in the encrypted `Secret` store; vault semantics reused; redaction extended with the Captell token and proxy password; events never carry them.
- Persona browsers run inside the sandbox boundary; the worker talks to them through the sandbox provider; no host Chrome.
- One Captell seat per project; balance checks run server-side.
- Operator takeover follows the existing lease rules (no takeover while the worker holds the execution lease unless the run is parked).
- Outbound verification fetches use an allowlist of hosts in the project funnel only.
- Tenant isolation: every query is org-scoped; the partial unique index includes `workspaceId`.

---

## 14. Observability and cost

- Every `RunStep` stores: duration, DOM snapshot (sanitised), screenshot, Captell credits, model tokens, proxy bytes, sandbox minutes.
- Per-project ledger and per-LIVE-link unit cost on the Overview tab. Rough expectation per LIVE link: Captell 10–30 credits ($0.01–0.03), model $0.01–0.05, proxy ≈ one static IP per persona per month (vendors list ~$1.2–2.7/IP/month for DE), sandbox minutes dominate and are bounded by the work window.
- Alerts (push + email): paused (balance, proxy), operator ticket opened, day finished below quota (with whyNot), helper version drift.

---

## 15. Testing strategy (deterministic and offline by default)

- **Core**: property tests for quotas, schedule windows (DST, weekends, overtime), funnel need computation, uniqueness, state machines (illegal transitions throw).
- **Drivers**: HTML fixtures per platform for register/login/post/permalink extraction; dockerised phpBB, MyBB and Flarum in `infra/fixtures/forums` for integration (free, fast to boot); Discourse via its public JSON fixtures.
- **Captcha**: `CaptellEmulator` replays each documented button label and API response (`Placed`, `No token`, `Missing site key`, `Unsupported type`, `Could not answer`, refusals, sandbox label, low balance). A fixture page hosts a fake widget so the Page Helper state machine is exercised without Captell's servers.
- **Browser**: fake `BrowserSession` for unit tests; Docker sandbox for e2e in CI (`pnpm test:e2e`), E2B/Daytona/Kernel as opt-in canaries (`pnpm test:canary`).
- **Mail**: AgentMail webhook fixtures for verification mails in DE/EN.
- **Verification**: fixtures with `nofollow`, `ugc`, removed link, deleted thread, `noindex`.
- **End-to-end vertical slice**: wizard → Start → fixture forum → Captell emulator → placement LIVE in the table, running fully offline in CI.

---

## 16. Delivery plan (milestones, each with acceptance criteria)

- **M0 Contracts and schema** — `BrowserSession`, `CaptchaSolver`, `ProxyProvider`, `SearchProvider`, `TextModel` in `packages/adapter-kit`; Prisma models + partial unique index; core state machines with tests. Accept: `pnpm test` green with ≥ 90% branch coverage on core transitions.
- **M1 Vertical slice (UI first)** — wizard, dashboard, project tabs, fake worker that emits realistic events, seeded demo project, mobile status + operator ticket screen. Accept: user creates a project with all required fields and clicks Start; dashboard shows NEW/LIVE and run state; a fake `needs_operator` ticket can be cleared from web and mobile.
- **M2 Real browser on Docker sandbox** — Playwright adapter inside the existing sandbox, persistent profile, Page Helper loaded, phpBB fixture register → verify mail (AgentMail emulator) → post → logged-out verify → LIVE. Accept: offline e2e passes in CI.
- **M3 Captell live** — `CaptellHttpSolver`, button state machine, image crop path, knowledge questions, balance pause. Accept: emulator suite green; one live canary against a Captell test seat records `placed_submitted`.
- **M4 Discovery and drafting** — DataForSEO adapter, probe, scoring, model lanes, refusal fallback, facts-only checks. Accept: for the demo lanes the funnel fills ≥ 20 qualified hosts in the primary market (DE) offline from recorded SERP fixtures, and a second recorded market (US/en) proves the per-market tagging; drafts pass QA checks deterministically with the recorded-model harness.
- **M5 Drivers breadth** — WoltLab, XenForo, Invision, vBulletin, MyBB, Discourse, Flarum, NodeBB, Vanilla + generic fallback (accessibility-tree form mapping, no screenshots). Accept: fixture suite per platform.
- **M6 Identity** — endpoint-template proxy adapter (per-country lease, sticky keys, ISP-or-residential tiering), locale coherence validator, pacing caps, Camoufox fallback. Accept: coherence tests; canary on two real boards (staging project, default undisclosed mode, staging brand).
- **M7 Operations** — re-verification schedule, whyNot report, alerts, cost ledger, operator queue expiry, webhooks. Accept: a simulated week in the fake clock produces correct LIVE/DEAD transitions and reports.
- **M8 Production hardening** — Daytona/E2B adapters for the browser session, Kernel adapter optional, rate limits, plan limits, Stripe stubs, README + PRODUCT.md (customer setup checklist mirroring the wizard).

The first implementation session should deliver M0 + M1 end-to-end (wizard → Start → fake run events → placements table), exactly as the previous plan intended, but on this repo's stack.

M0 deviations (as built):

- Active proxy leases are unique per project × country (`lb_proxy_leases_one_active_per_project_country`), following section 8; section 5's "one active lease per persona" is read as one per persona and country. `proxyPolicy` keeps the value `static_isp_per_persona`, now meaning ISP where available, otherwise sticky residential.
- `persona.language` is optional and falls back to the primary market's language. Each market stores its `locale` and `timezoneId` explicitly; deriving defaults from the country is left to the M1 wizard, and the per-session coherence check to M6.
- `LbCaptchaOutcome` adds `sandbox` for the helper's sandbox label (section 15 emulator).
- `insertReference` has built-in reference sentences for German and English only. Other languages need a `[REF]` marker from the drafter or a caller template.

M2 deviations (as built):

- Additive contracts only:
  - adapter-kit adds `BrowserSessionFactory` (`mode: "local" | "sandbox"`), an optional `loadedExtensions` on `BrowserSession`, and an optional `MailboxProvider.listMessages`.
  - The API adds `artifactIds` on `LbRunStepView`, `screenshotArtifactId` on `LbOperatorTicketView`, and the `linkBuilder.artifacts.get` route with `LbArtifactViewSchema`. That route only serves artifacts that the project's steps or placements reference.
  - There is no schema change. The ticket screenshot is the last PNG of the newest step on the same run and host, recorded up to 60 s after the ticket.
- The browser lives in the new `packages/linkbuilder-browser`.
  - Patchright is the default, with Playwright as the fallback, and both use Playwright's bundled Chromium. The proxy is Playwright's `proxy` option; proxy leasing stays in M6.
  - `local` mode requires `LINK_BUILDER_BROWSER=local`. It is refused under `NODE_ENV=production` unless `LINK_BUILDER_ALLOW_LOCAL_BROWSER=true` is also set.
  - `sandbox` mode is the default. It starts one detached runner (`rakazo-lb-browser serve`) per persona profile through `SandboxProvider.execute`, then sends one `call` exec per operation, with JSON-RPC carried in an env var.
  - The sandbox image must ship Node, `/usr/bin/chromium` and the runner bundle. This has not been verified against a live sandbox.
- Drivers live in `packages/linkbuilder-drivers`.
  - Only phpBB is implemented, against an offline Node fixture board. Its templates are `.html.tmpl` so Biome does not lint them as app HTML.
  - `BoardDriver` adds `readRegistrationResult` and `registerSubmitSelector`, so an operator continue re-reads the page instead of submitting again.
  - The Page Helper loop finds the button through `[data-page-helper]`, which is an assumption made by the fixture. M3 must confirm it against the real Captell helper.
- The worker runs the real pipeline when `LINK_BUILDER_DRIVER=real`.
  - It uses an interval loop rather than a Graphile task. Each tick takes a per-project advisory lock and a fenced lease, and writes one step per `runId + stepIndex`.
  - Open sessions and per-host page facts are held in memory per project and market. After a worker restart, `open_session` resets them.
  - Three consecutive step errors on the same host mark that host `failed`.
- M2 has no discovery: the e2e seeds hosts as `qualified`. Replies come from a fixed de/en template (`modelId: "template-m2"`) rather than the LLM, and no warm-up posts are made.
- Logged-out verification uses plain `fetch` with the verifier user agent and no cookies, rather than got-scraping.
- Real mode wires `FakeCaptchaSolver` and `AgentMailEmulator` until M3. Against a live board the email step therefore waits until a webhook reaches the emulator.
- Forum logins are stored as workspace-shared SiteLogins with bot id `link-builder`. `normalizeSiteLoginHost` drops the port, so the worker picks a username with no stored login on that host.
- `pending_admin` moves the host without creating a ticket. A Page Helper decision without a host event, such as `pause_project`, parks the host for the operator instead of pausing the whole project.
- The M1 placeholder mailbox address is derived from the persona name, so two projects with the same persona name share an address. The e2e uses distinct personas; real inbox provisioning (M3) removes the collision.
- The PGlite test database replays the real migrations and strips `CONCURRENTLY`, which PGlite does not support inside its single connection.

M3 deviations (as built):

- `CaptellHttpSolver` and `CaptellEmulator` live in `@rakazo/adapters`. The worker, drivers and UI talk only to `CaptchaSolver`. The emulator is an in-process `fetch`; tests inject it. The MCP endpoint is not called. Redirects are refused so the bearer token cannot leave the Captell base URL. The token is loaded per call from the encrypted store and is redacted from errors.
- `CaptchaSolverError` takes an optional `{ retryable }`. The default mapping is unchanged. Captell marks `not_read` not retryable (the crop path does the one re-crop), `no_token` retryable, and a network or HTTP 5xx retryable only when the solver's own retry budget was not spent.
- `BrowserSession.elementScreenshotPng` accepts `{ paddingPx }`. Optional `injectToken` and `extensionVersions` were added. The RPC session forwards them.
- Image crops must be at least 100 bytes and between 40×16 and aspect 1.5–12. One 12px re-crop, then park. `not_read` gets one further padded re-crop, then park with that reason. The phpBB fixture covers both.
- A new run step `helper_connected` runs after `open_session` and before any other browser step. The version is read from the extension manifest when a service worker is loaded, otherwise from `html[data-page-helper-version]`. The fixture helper's manifest is `2026.10.4.16`. A mismatch or a missing version parks the host. The worker does not open `captell.run/login`, `captell.run/extension/connect` or `hcaptcha.com`. The connect page check stays in the live canary (`docs/link-builder-captell-canary.md`).
- The Page Helper button selector remains `[data-page-helper]` (`PAGE_HELPER_BUTTON_SELECTOR`). The live canary must confirm helper `2026.10.4.16` uses it. Real mode can override `pageHelperButtonSelector`.
- Widget fallback, when the helper button is absent: `solve({ type, websiteURL, websiteKey })`, then inject into `g-recaptcha-response` / `cf-turnstile-response` / `h-captcha-response` and submit in the same step. Site keys also come from Invision `data-ipsCaptcha-key` and an iframe `k=` parameter. Human-checkbox selectors are still unset, so a page with no matching checkbox is `none`. The canary must confirm that on a real widget.
- Knowledge fields (`#qa_answer` and the same shape) call `answerQuestion`. `couldNotAnswer` parks the host with the question text on the ticket.
- `lb_captcha_events.taskId` is a nullable column (`20261005180000_lb_captcha_task_id`). Events store type, door, outcome, credits and task id. Never the token, the answer or the image. A balance pause uses type `unsupported` and outcome `credits` because the type enum has no balance value, and it is written only in the transaction that moves the project from `active` to `paused`.
- A solver `credits` error and a Page Helper `pause_project` pause the project. M2 parked the host instead. A `sandbox` label pauses on balance and parks the host on a solve. The Captchas tab shows "Sandbox answer. The Captell desk is not production-configured."
- Real mode (`LINK_BUILDER_DRIVER=real`) builds `CaptellHttpSolver` when the project has an `lb_captcha` secret and otherwise records one run step, "Real mode needs a Captell token for this project", and does not open the browser. `LINK_BUILDER_DRIVER=fake` is unchanged. Tests may still inject `FakeCaptchaSolver` or the emulator.
- Mailbox provisioning is not in M3. `apps/api/src/agentmail.ts` only lists and assigns existing bot inboxes. There is no signature-verified inbound route mapped to a link-builder project by inbox id, and no create-inbox `MailboxProvider`. Doing that halfway would leave a live webhook without a verified project mapping. Real mode keeps `AgentMailEmulator`, and the M1 `@inbox.example` address stays, until M7/M8.

M4 deviations (as built):

- One footprint query per topic-lane tag per market, not one query per platform. The OR group in section 6.1 already covers the platforms. The keyword is the lane tag. Search localisation is the market country and language. `primary_first` with empty supply searches every market, because supply is still below the day's need.
- Hosts store `locale` and `timezoneId` (`20261005210000_lb_host_market`) plus the existing country and language. That tag is what a later session reads. `lb_projects.lastDiscoveredAt` marks the last discovery pass.
- Discovery runs on the real runner's existing interval, not a new Graphile task (same shape as M2). It runs when a project has never been discovered, then once per local day from 03:00. `LINK_BUILDER_SEARCH=off` skips it. The default provider is `RecordedSearchProvider`. `LINK_BUILDER_SEARCH=dataforseo` uses `DataForSeoSearchProvider` with basic auth from the workspace secret kind `lb_search` (`login:password` in the encrypted store). Unknown countries are refused rather than searched in the wrong place. Credentials are redacted from errors.
- Probe HTML is fetched server-side with an injected `fetch`. Only http(s) URLs on the registrable domain from that search hit are requested. Private hosts are refused unless a test opts in. A row is inserted at the settled status; the host state machine is applied in memory first (`discovered` → `probed` → `qualified`, or straight to `unsupported_captcha` / `denied` / `dead`).
- A thread the driver just listed, with no `lastActivityAt`, counts as active. Drivers still return only title and URL until M5, so the live reply path sends an empty excerpt and no earlier replies to the model.
- Plan 9 names models by product. The OpenRouter adapter defaults to `google/gemini-3.8-flash` for draft and classify, and `moonshotai/kimi-k3` for fallback, overridable with `LINK_BUILDER_MODEL_DRAFT|CLASSIFY|FALLBACK` and `content.modelLanes`. Draft moved off Claude Fable 5 so an end-user deployment can pay for strong writing without frontier prices. It calls the same chat-completions endpoint the Pi runtime already uses. No new vendor SDK. The customer does not connect a model; `OPENROUTER_API_KEY` on the deployment is the key.
- `content.mode` is `discard` (default) or `queue` for a fit check with `factsOnly: false`. `content.threadActivityDays` defaults to 180. `content.excludedLaneIds` is the lane exclusion list. All three are JSON defaults, so existing projects still parse.
- `undisclosed_persona` adds no disclosure text. `disclosed_persona` and `disclosed_brand` append `persona.disclosureText`. A testimonial is kept only when `facts[]` contains that same sentence. A link that would break `linkRatio` is posted without the link. `drafts_only` saves `drafted` and does not submit; `drafts.approve` / `drafts.discard` are the queue. Approve is only accepted in `drafts_only`.
- Warm-up replies are a `warmup_post` step with `linkSlot = none` while the account is still short of `minPostsBeforeLink`. The age gate still waits without posting. The fixed `template-m2` reply is no longer used by the real pipeline. `LINK_BUILDER_DRIVER=fake` is unchanged.
- A model refusal, schema failure or `confidence < 0.3` retries once on the fallback lane and increments `whyNot.modelRefusals`. The supply counts in that object stay as they were (or zero if none was stored yet). The full why-not report remains M7.

M5 deviations (as built):

- Nine platform drivers share `MarkupBoardDriver`. phpBB stays its own class. `unknown` gets a new `GenericFormDriver` per call. `qa_other` still has no driver.
- Additive contract only. `BoardThread` gained `lastActivityAt` and `openQuestion`. `LinkRuleProbe` gained `relDefault`. `BoardDriver` gained `detect`, `setProfile`, `nofollowDefault`, `minPostsBeforeLink`, and optional `probePageLinkRule`. `RegistrationPage` gained `unmapped`. `UnmappedFormError` parks the host with ticket reason `unmapped_form`. The reason column was already a string; `20261005220000_lb_unmapped_form` replaces its check constraint. No new column.
- `BrowserSession.formFields` is optional. Playwright, the RPC session, and the fake implement it. The generic mapper uses that list only. It does not screenshot a page to map a form.
- `fillRegistration` ticks a consent checkbox when one is present. A knowledge answer is still typed by the captcha step, so the driver does not invent one.
- Discourse `minPostsBeforeLink` is 1. Core TL1 is a reading gate, not a post count. The floor means a link cannot be the account's first post. The runner uses the greater of that floor and the project warm-up.
- Pacing stays on `PlaywrightBrowserSession`. Every driver action goes through `BrowserSession`, so the same policy applies.
- Profile is written inside the existing post step, not a new step kind. The bio is `persona.bio` or the display name, with no affiliation. A signature is the first target URL only when `signatureLinks` is set, warm-up is met, and a target exists.
- A fixable registration error (username taken, banned email, password required) is corrected once. A taken username is rotated in the vault. The next register step resubmits. A second failure marks the host dead. Other form errors are dead immediately.
- Fixtures are loopback Node servers and `.html.tmpl` files, the same shape as M2 phpBB, not Docker images. Flarum's fixture door is none. Discourse's is hCaptcha. MyBB and vBulletin are image letters. The others are widgets (Turnstile, reCAPTCHA, hCaptcha, or Invision `data-ipsCaptcha-key`).
- MyBB posts use `id="pid<id>"` so logged-out verification can see the `#pid<id>` permalink. Permalink parsers also accept the alternate shapes in the M5 brief: vBulletin `/threads/<id>-slug?p=`, NodeBB `/topic/<id>/slug/<index>`, and Invision `?do=findComment&comment=`.

M6 deviations (as built):

- `ProxyEndpoint` gained an optional `protocol` (`http` | `socks5`). `BrowserPersona` gained optional `acceptLanguage` and `engine` (`chromium` | `camoufox`). `BrowserSession.navigationMeta` is optional. The API adds `linkBuilder.proxyLeases.list`, which returns country, kind, provider id, expiry and status only.
- IPRoyal's published residential grammar puts `_country-` `_session-` `_lifetime-` on the password. The password secret stays opaque. The preset stores that grammar in `passwordSuffixTemplate` and appends it only inside `materialize`, after the secret is loaded. Oxylabs keeps country, session and TTL in `usernameTemplate`. Both presets use `proxy.example:8080` until a deployment overrides the host and port. `{country}` is rendered lowercase.
- The sticky session is the first 8 hex characters of SHA-256(stickyKey), which matches IPRoyal's 8-character session. A blacklisted exit releases the row and leases `stickyKey:2`, `:3`, … The host is flagged `ip_blacklisted` in `notes`. The account row stays.
- Renewal runs on the existing real-runner tick, not a new Graphile task, same shape as M2. A lease inside 10 minutes of `renewsAt` is renewed in place. Expiry does not rotate the IP.
- Coherence parks the host (`parked_operator`, `statusReason = coherence_refused`) and does not open an operator ticket. The project stays active. Unknown countries use Intl: a locale with a region must name that country, a region-less tag is allowed, and the time zone must be a supported IANA id.
- Camoufox is Playwright Firefox plus `LINK_BUILDER_CAMOUFOX_PATH`. The Page Helper is not loaded; captcha uses the M3 API-token door. A missing executable is `unavailable` and the host goes `dead` with `edge_block`. CI does not install Camoufox.
- Pacing constants gained `MAX_REGISTRATIONS_PER_HOST_PER_DAY = 1` and `HOST_IDLE_GAP`. The idle wait runs only when the runner was given a `sleep`. Verification, Captell and DataForSEO fetches are unchanged and still take no proxy.
- Mobile has no Settings tab. Leases are on the web project Settings tab only.

M7 deviations (as built):

- Scheduled work stays on the existing runner tick. There is still no Graphile task. Pure `due(now)` functions in `@rakazo/linkbuilder-core` decide re-verification, nightly discovery, proxy renewal, the Captell balance check, window and overtime, ticket expiry and webhook backoff. The tick steps only the run whose date is the local date of that clock.
- Re-verification offsets are T+0 (2 minutes), T+1d, T+3d, T+7d and T+30d from `placement.createdAt`. `verifyCount` stores how many checks have finished. `LINK_BUILDER` tests can still set `verifyDelayMs` to 0 for the first check. A removed or dead outcome clears `counted` and frees the partial unique slot. The host stays `used`, because that status is terminal; a later placement on the host can count again. LIVE counters move with `createdAt`'s local day, not the latest `verifiedAt`.
- `operator.ticketTtlHours` defaults to 24 and `operator.onExpire` defaults to `skip` (`parked_operator` → `dead`). `requalify` returns the host to `qualified` (`park_requalified`). `parkedHostTtlHours` is unchanged and is no longer the ticket clock.
- Alerts are `LbAlert` rows (`project.paused`, `captcha.needs_operator`, `placement.live`, `run.finished`) with a per-project dedupe key, so a condition notifies once. Push uses the existing Expo provider with `data.url` `/link-builder-ticket`. Outbound webhooks are HMAC-SHA256 over the raw body (`X-autoSEO-Signature: sha256=<hex>`), three attempts (0s, 60s, 5m), logged on `LbWebhookDelivery`. The URL must be https; production refuses private and loopback hosts. The signing secret is `whsec_…` in the encrypted store (`lb_webhook`).
- Costs are `LbCostEntry` rows: Captell credits from captcha events, model tokens from run steps (lane in the step outcome), one row per search query, one proxy-lease day per successful renewal. `linkBuilder.costs.summary` is the project total for the local day or ISO week. The ledger stores quantities only.
- Mailbox provisioning calls `MailboxProvider.ensureInbox`. Without `AGENTMAIL_API_KEY` the address is `lb-<projectId>@inbox.example`, so persona names no longer collide. With the key, `AgentMailMailbox` posts to AgentMail. Inbound `POST /api/link-builder/mail` checks `X-AgentMail-Signature` with `AGENTMAIL_WEBHOOK_SECRET` and stores the message on `LbInboundMail` after verification-link extraction. `AgentMailEmulator` remains the test double. The live check is a deployment with those two secrets and a public https webhook URL; CI does not call AgentMail.
- The subscribe cursor now includes the latest placement and alert as well as the step and ticket.
- A low Captell balance, a proxy lease past `renewsAt`, or a project with no mailbox pauses the project and emits one `project.paused` alert.

M8 deviations (as built):

- This milestone was built on Grok 4.7 after the Other Models pool was exhausted.
- Daytona and E2B already forwarded command env (`env` / `envs`) and already ran the factory's `sh -c` start script, including the detached `nohup` serve. Offline tests drive both providers with fake SDK clients: env is present, a non-zero start exit fails, and a runner that never answers ping fails on the timeout. No live Daytona or E2B sandbox was used. The README states the image expectation (Node, `/usr/bin/chromium`, `rakazo-lb-browser` on `PATH`, a display for the operator live screen).
- Kernel is an optional `BrowserSessionFactory` (`mode: "kernel"`) in `@rakazo/adapters`. It is constructed only when `LINK_BUILDER_BROWSER=kernel` and `LINK_BUILDER_KERNEL_SECRET_ID` are set. HTTP goes through an injected fetch, https only, credentials as `SecretRef`. Extension zips are not uploaded; `LINK_BUILDER_KERNEL_EXTENSION` names extensions already stored in the Kernel project. The operator live screen stays the sandbox display. No Kernel SDK and no live Kernel call. Browserbase is named in the architecture and is not in the M8 acceptance line, so it was not added.
- Link-builder RPC is limited per workspace by an in-memory window in the API process (120 requests / 60 s). There is no shared limiter in the repo and no Redis.
- Plan caps live in `@rakazo/linkbuilder-core` (`projects`, `live_per_day`, `personas`). A start checks them first. A placement is counted only while that project's `liveToday` is under `live_per_day` (per project, not summed across the workspace, because each project has its own local day). `PlanProvider` is in adapter-kit. `StaticPlanProvider` returns the `starter` plan (3 / 10 / 3). `StripePlanStub` returns the same plan and refuses every webhook. No Stripe SDK, no live key, and no billing route.
- Scheduled work stays on the existing runner tick. It was not moved onto a Graphile task.
- `proxyResolverFor` records a revealed proxy string once. `webhookUrlAllowed` stays syntactic outside production; in production it also resolves the hostname through an injected resolver and refuses when any answer is private, loopback, link-local, CGNAT, or metadata. Tests inject the resolver. Validation does not fetch the URL. Delivery uses `redirect: "error"`, so a 3xx cannot retarget the POST at a private address after the DNS check.

---

## 17. Decisions needed from Harold

1. Build inside this monorepo (recommended) instead of a new Next.js app. Yes / no.
2. ~~Default disclosure mode~~ **Decided 2026-10-05: `undisclosed_persona` is the default; no checkbox — `responsibilityAck` is recorded when Start building is clicked, with the terms in the ToS; fabricated testimonials stay forbidden in every mode.**
3. ~~Proxy vendor~~ **Decided 2026-10-05: worldwide, per host country. `ProxyProvider` takes a country; no hard-coded regional pool. v1 adapter is the vendor-neutral endpoint-template adapter; IPRoyal is the first configured vendor (ISP where available, residential sticky fallback), Oxylabs the second. See section 8.**
4. Discovery vendor: DataForSEO (already available) vs Serper (cheaper per query). Default: DataForSEO.
5. Draft model lane default: Claude Fable 5 (quality) vs Gemini 3.8 Flash (cost) vs pinning a never-refusing fallback model (Kimi K3 / DeepSeek V4.1). Default: Claude Fable 5 with automatic fallback, Gemini 3.8 Flash for classify.
6. Count `nofollow`/`ugc` links toward LIVE quota by default (recommended yes, shown honestly) or only followable links.
7. Captell go-live: confirm the desk is production-configured (upstream solver key set, no `sandbox` label) before the first customer run.

If no answer is given, the defaults in each line apply (monorepo yes; DataForSEO; Claude Fable 5 + fallback; count `nofollow`/`ugc`). Decisions 2 and 3 are taken.

---

## 18. How the build runs in Cursor

### 18.1 Shape

- One milestone = one Cloud Agent builder = one branch `cursor/lb-m<N>-<slug>` = one PR into `main`. Milestones run strictly in order; M<N+1> starts only after M<N> is merged, because each builds on the contracts of the previous one.
- A coordinator agent (this conversation, or a human) launches each builder with a pinned model, reviews the diff against this plan, runs `pnpm lint`, `pnpm check`, `pnpm test` (plus `pnpm test:e2e` from M2), and follows CI and review bots until there is no actionable feedback (AGENTS.md rule). Live canaries (real board, Captell seat, proxy) are coordinator-run only, in M3 and M6, with a staging brand.
- Every builder receives the same spec: this document plus the milestone's acceptance line from section 16. The spec, not the model, keeps the architecture consistent across cheap and expensive milestones.

### 18.2 Model per milestone

| Milestone | Pinned model | Reason |
| --- | --- | --- |
| M0 contracts, schema, core state machines | Claude Opus 5.5 (or Fable 5.1) | Everything downstream depends on it; long-horizon agentic coding is where these models lead (Terminal-Bench 4.0 57.9% vs 38.0%, FrontierSWE v2 56.3% vs 29.5%, Sept 2026 vendor tables). |
| M1 wizard, dashboard, mobile, seed | Grok 4.7 (or Auto) | Well specified, repetitive, visually verifiable; ~5x cheaper per token. |
| M2 browser adapter in sandbox | Claude Opus 5.5 (or Fable 5.1) | Real side effects, persistent profiles, extension loading; expensive to debug live. |
| M3 Captell | Claude Opus 5.5 (or Fable 5.1) | State machine with credit and token-TTL consequences. |
| M4 discovery + drafting lanes | Grok 4.7 (or Auto) | Adapters and prompts behind contracts with offline fixtures. |
| M5 nine forum drivers | Grok 4.7 (or Auto) | Repetitive per-platform work against HTML fixtures with a shared interface. |
| M6 identity / proxy / pacing | Claude Opus 5.5 (or Fable 5.1) | Security-sensitive (secrets, sandbox boundary, proxy credentials). |
| M7 operations, alerts, reports | Grok 4.7 (or Auto) | CRUD-heavy, fully testable with a fake clock. |
| M8 hardening, provider adapters, docs | Claude Opus 5.5 (or Fable 5.1) | Security review, rate limits, plan limits. |

Auto is acceptable where listed; it chooses by task and capacity and does not know which milestones are expensive to get wrong, so the pinned rows stay pinned.

### 18.3 Kickoff prompt template (paste per milestone)

```text
Implement milestone M<N> of docs/autoseo-link-builder-plan.md in this repository.

Read AGENTS.md, the whole plan, and the existing code it names (apps/web, apps/api, apps/worker,
packages/adapters, packages/adapter-kit, packages/contracts, packages/db) before writing code.
Scope is exactly M<N>; do not start M<N+1>. Follow the contracts and names in the plan; if the plan
is wrong or ambiguous, say so in the PR description and choose the smallest change that keeps later
milestones possible.

Done means: the acceptance line for M<N> in section 16 is met, `pnpm lint`, `pnpm check` and
`pnpm test` pass locally, tests are deterministic and offline, no secret appears in code, tests,
logs or docs, and the PR description lists what was built, what was skipped and why.
Branch: cursor/lb-m<N>-<slug>. Open a draft PR against main.
```

### 18.4 Definition of done per milestone

- Acceptance line from section 16 demonstrably met (screenshot or test output in the PR).
- CI green; Bugbot / review-bot threads resolved; no `TODO` without an issue link.
- New contracts documented in the plan's domain model or marked as a deliberate deviation.
- For M2, M3, M6: coordinator-run live canary passed and its log attached to the PR.

---

## Appendix A — Platform footprints and link rules (initial driver knowledge)

| Platform | URL footprint | Register path | Typical captcha | New-member link rule |
| --- | --- | --- | --- | --- |
| WoltLab Suite / Burning Board | `/forum/thread/<id>-slug/`, `/wcf/` | `/register/` | reCAPTCHA v2 / Turnstile, knowledge question | often links after N posts; signature after N posts |
| phpBB 3.x | `viewtopic.php?t=`, `ucp.php?mode=register` | `ucp.php?mode=register` | image "Bestätigungscode", Q&A plugin, reCAPTCHA | links sometimes blocked for < N posts; `rel=nofollow` common |
| XenForo 2.x | `/threads/slug.123/`, `data-xf-init` | `/register/` | reCAPTCHA / hCaptcha / Turnstile, Q&A | links allowed; signature links by group |
| Invision Community | `/topic/123-slug/`, `data-ipsCaptcha-key` | `/register/` | Turnstile via `data-ipsCaptcha-key`, reCAPTCHA | moderated first posts |
| vBulletin | `showthread.php?t=`, `/threads/` | `register.php` | reCAPTCHA, image | links after N posts |
| MyBB | `showthread.php?tid=` | `member.php?action=register` | image, reCAPTCHA/hCaptcha | usually allowed |
| Discourse | `/t/slug/123`, `/t/123.json` | `/signup` | hCaptcha/none | TL0 cannot post links; TL1 after reading/time — warm-up is mandatory |
| Flarum | `/d/123-slug` | modal `/register` | reCAPTCHA/none | allowed |
| NodeBB | `/topic/123/slug` | `/register` | reCAPTCHA/hCaptcha | reputation gates |
| Vanilla | `/discussion/123/slug` | `/entry/register` | reCAPTCHA | allowed |

## Appendix B — Captell integration facts used in this plan (from captell.run/docs, 2026-10-05)

- Doors: mail (`ImageToText` subject, `token:`/`reply:` lines, one tight image ≥ 100 bytes), Page Helper extension (Chrome/Edge, v2026.10.4.16, connect via `https://captell.run/extension/connect?token=…`), userscript fallback `https://captell.run/captell.user.js?token=…`, MCP `https://captell.run/api/mcp`, HTTPS `POST /api/v1/solve`, `POST /api/v1/answer`, `GET /api/v1/balance`, `GET /api/v1/tasks/:id`.
- Credits: ImageToText 4, reCAPTCHA v2/v3 10, Enterprise 25, Turnstile 10, hCaptcha 10, GeeTest 9, FunCaptcha 15; failed solves refund; refused requests cost nothing; Page Helper supports Google, Cloudflare, hCaptcha only.
- Token TTL ≈ 2 minutes after `Placed`; `Placing…` resets after 3 minutes; max 4 tries; `Missing site key` / `Unsupported type` are terminal for that host.
- Form errors that are not captcha failures: username taken, banned email, "Entering a password is required." / "Die Eingabe eines Passworts ist erforderlich."

## Appendix C — Evidence consulted

- Captell docs, extension, pricing and script pages (captell.run/docs, /extension, /pricing, /for/script, /for/cursor).
- Chromium extensions group: `--load-extension` removed in Chrome 137 branded builds; Playwright docs "Chrome extensions" (use bundled Chromium, persistent context).
- Anti-detect benchmark May 2026 (31 Cloudflare targets, 651 verdicts): Patchright 25/31, Camoufox 25/31, vanilla 24/31, rebrowser 24/31 (stale); maintenance table Sept 2026.
- Cloud browser comparisons 2026 (Kernel, Browserbase, Steel, Hyperbrowser, Anchor): extension upload documented for Kernel and Browserbase; profiles and BYO proxies broadly available.
- KI-Schreibranking (German writing, 102 models, 4 Oct 2026) and dach.peerbench.ai German index (Sept 2026).
- ISP proxy coverage and pricing pages (IPRoyal, Oxylabs, Decodo) for DE/AT/CH.
- Search API pricing comparisons 2026 (DataForSEO, Serper, Brave, Exa, SerpAPI); one live DataForSEO Google-DE query validating the footprint approach.
- § 5a Abs. 4 UWG commentary (omsels.info), § 6 DDG / § 8 Abs. 2 UWG attribution notes, KG "Getarnte Link-Werbung".
