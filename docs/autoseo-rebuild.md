# AutoSEO campaign release runbook

The detailed [rebuild plan and delivery status](./autoseo-rebuild-plan.md) is retained in this repository for future work.

This runbook describes the campaign implementation in this checkout. No production deployment, live provider request, or production migration was performed as part of this work. The three additive migrations were applied to the verified local development database.

## Application release authorization

On 2026-11-03, the user explicitly said “merge and publish so I can test.” This authorizes the current application release; root handles Git/publishing, with Astra reviewing deploy readiness. Do not ask the user to repeat authorization for this same release. Authorization is not evidence that deployment has happened or that runtime/service ownership, access, backup/restore, migration, or production health gates have passed. Verify those facts before production data changes or runtime mutation, and record the actual revision and results after release.

Application release and campaign posting are separate. This authorization does not activate a campaign, enable paid providers, create accounts, send email, or publish an external contribution. Paid provider flags remain disabled by default; any external contribution requires its own deliberate action and human review of the destination and content.

## Implementation status

Campaigns have persisted API and worker flows for setup, automatic bounded official-site cataloging, public-URL research, contribution drafts and review, activity/history, pause/resume, retry/defer/skip, and verification state. Research fetches an explicitly supplied public URL without cookies or credentials, removes executable page content, enforces size/time bounds, and rejects private or local network destinations. Suggested contributions remain drafts for human review.

`controlled` mode exercises account, email-confirmation, contribution, and verification transitions with synthetic local fixture records. It does not create real accounts, send email, or publish to an external site. The optional image-to-text challenge provider handles only an explicitly authorized image task; it does not automate a browser, complete site registration, or verify email. Challenge solving is deployment-owner-only, disabled by default, and its returned solution is stored through the encrypted secret store. The server reconciles already-created task IDs with bounded polling and expires stale tasks even when the browser closes; it never automatically creates replacement paid tasks.

An optional Pi model adapter can draft source-backed contributions. It is disabled by default, restricted to the configured deployment owner, bounded by the shared campaign daily reservation ledger, and always produces reviewable text rather than approving or publishing it. Provider charges can differ from estimated/reserved cost; reservations are accounting controls, not provider-enforced hard spending caps. Actual usage is recorded and further reservations are blocked when the shared daily budget is exceeded.

An optional Discourse provider supports deployment-owner review and explicit publication to a configured Discourse topic, followed by anonymous public verification. It is disabled by default and gated by campaign mode/status, a positive publication budget, a reviewed-content hash, and configured credentials. The adapter does not retry creates and does not claim exactly-once posting. Real Discourse credentials, account registration, email flows, and live-site verification have not been exercised here. No integration supports arbitrary website publishing, universal automation, or guaranteed SEO gains.

## Optional provider settings

Leave feature flags unset or set them to `false` unless a deployment owner has configured and deliberately enabled the provider. Keep all keys in the server-side secret manager; never expose them to the browser.

| Variable | Purpose and requirements |
| --- | --- |
| `ENCRYPTION_KEY` | API encryption key used by the encrypted secret store for challenge output and other stored provider secrets. Required by the API configuration. |
| `ANTI_CAPTCHA_API_KEY` | Server-side Anti-Captcha key for manual image-to-text challenge solving. |
| `CAMPAIGN_DISCOVERY_ENABLED` | Read-only bounded community search is enabled unless exactly `false`; it requires verified official catalog evidence and performs no paid model calls or external writes. |
| `CAMPAIGN_PAID_CHALLENGES_ENABLED` | Must be exactly `true` to enable paid challenge tasks; defaults off. |
| `CAMPAIGN_CHALLENGE_RESERVATION_MICROS` | Positive integer reservation amount per challenge task; required for paid tasks. Shares the campaign daily budget accounting with model drafting. |
| `CAMPAIGN_AI_DRAFTING_ENABLED` | Must be exactly `true` to enable optional model drafting; defaults off. |
| `CAMPAIGN_AI_RESERVATION_MICROS` | Positive integer maximum reservation per model draft; required for model drafting. Each request reserves its calculated estimate within this ceiling and shares campaign daily accounting with challenge tasks. |
| `CAMPAIGN_AI_PROVIDER_ID` | Configured Pi provider identifier for campaign drafting. |
| `CAMPAIGN_AI_MODEL_ID` | Configured Pi model identifier with usable catalog pricing. |
| `CAMPAIGN_AI_API_KEY` | Optional dedicated model key; falls back to `OPENROUTER_API_KEY`. Keep server-side. |
| `CAMPAIGN_AI_OWNER_USER_ID` | User ID allowed to use the deployment-configured drafting provider. |
| `DISCOURSE_BASE_URL` | HTTPS base URL of the authorized Discourse site, without credentials, query, or fragment. |
| `DISCOURSE_API_KEY` | Server-side Discourse API key. Keep secret. |
| `DISCOURSE_API_USERNAME` | Discourse API username associated with that key. |
| `CAMPAIGN_DISCOURSE_PUBLISHING_ENABLED` | Must be exactly `true` to enable reviewed Discourse publication; defaults off. |

For challenge solving, the feature flag, API key, and positive reservation must all be configured. For model drafting, enablement, owner ID, provider/model, key, and positive reservation are required. For Discourse, the HTTPS URL, key, username, and flag are required; actual use is still restricted to the deployment owner and eligible research campaigns. The configured publication daily limit must be positive.

## Local preview and checks

Start the public site from the repository root with:

```sh
pnpm --filter @rakazo/www dev
```

The authenticated product can be run with the existing local API/worker/web setup (`pnpm dev`) against an isolated development database. Keep all paid provider flags disabled during ordinary development. Never use production credentials for local tests.

Relevant checks from the repository root:

```sh
pnpm --filter @rakazo/www check
pnpm --filter @rakazo/www build
pnpm --filter @rakazo/adapters test
pnpm --filter @rakazo/adapters check
pnpm --filter @rakazo/api test
pnpm --filter @rakazo/db test
pnpm --filter @rakazo/web check
pnpm --filter @rakazo/web test
```

The isolated integration harness is `pnpm test:integration`; it starts a disposable PostgreSQL container, migrates it, and runs integration suites including campaign persistence, challenge-budget concurrency, publication ambiguity and authenticated API tests. The E2E harness is `pnpm test:e2e`. Both use disposable local infrastructure and test configuration; do not repoint them at shared or production databases. Direct database campaign tests use `CAMPAIGN_PG_TEST_URL` when run outside the harness. Adapter unit tests for campaign research, drafting, Discourse publication, and campaign worker behavior use fakes and do not make live provider calls.

## Migrations and rollback

Campaign persistence is introduced by these additive migrations:

- `20261102120000_campaigns`
- `20261102123000_campaign_challenge_tasks`
- `20261102130000_campaign_publication_actions`

Before applying migrations to a persistent database, take a fresh backup and rehearse restoring it into an isolated database. Confirm the restored application starts and that both existing data and campaign tables are intact. Apply migrations only as an explicit release step with the database and service owner present. The repository command is `pnpm --filter @rakazo/db migrate`; some Compose startup paths may also apply pending migrations, as described in [self-hosted upgrades](./self-host.md). No production migration command was run here.

For application rollback, stop campaign workers and deploy the previous application version while retaining the additive schema and campaign rows. Do not drop campaign tables or delete action receipts, activity events, challenge reservations, publication actions, or ambiguous-operation records: later code may need them to reconcile external effects. Restore a backup only after stopping writes and coordinating with the service owner; restoration can discard later changes.

## Publication and verification limits

Discourse post creation is a single explicit request with no automatic retry and no server-side exactly-once guarantee. A timeout, redirect, malformed success response, or other ambiguous result must be reconciled against durable action state before any new create request is considered. The server schedules bounded public verification for known receipt IDs even when the browser closes; a manual check is also available. Verification uses an unauthenticated read and checks an actual rendered anchor against the normalized expected URL. Private, hidden, moderated, deleted, or anonymously inaccessible posts remain pending or unverified; an administrator-only view does not establish public placement. A successful check proves only that the link was observed publicly at that time, not future availability, indexing, ranking, or SEO results.

Before enabling a provider, the deployment owner must separately validate its credentials, intended account/site, budget settings, rollback procedure, and real end-to-end behavior. Keep optional paid provider flags disabled unless that provider is separately configured and deliberately enabled. This checkout has not been deployed as part of the recorded work.

## Remaining live validation

The current runtime does not expose `ANTI_CAPTCHA_API_KEY` or Discourse credentials. Saved secret-binding metadata is not proof that a running process has received the key; refresh the intended runtime injection before checking readiness. No key was judged invalid and no replacement secret is requested by this runbook. Optional model credentials/owner and positive spending/reservation configuration are also absent from this runtime; drafting requires those settings and a priced model before it can run.

The first project is confirmed in a separate local brief. Inspect its official source material and discover eligible communities once development network access is active; do not require the user to choose a forum platform before discovery. Then establish the authorized account/mailbox for the evidence-selected site before implementing or exercising its real signup/email workflow. Automatic official-site cataloging is locally verified within its 12-page/depth-two batch limits. Community search, inspection and explicit candidate disposition are implemented and locally browser-verified. General account registration, email confirmation and browser challenge application remain outstanding rather than inferred from controlled fixture success. Railway/service ownership, actual runtime access, and a fresh backup/restore rehearsal for `app.autoseo.run` and `autoseo.run` remain unverified readiness gates; the application release authorization does not waive them. Campaign selection and live limits must be established before campaign activation or posting. Older campaign names/volumes are provisional and were not executed.

The live pilot is not complete. Passing local builds, fixtures and fault tests do not establish externally working signup/email, paid provider behavior, public publication or production health.

## Verification recorded in this workspace

- Workspace typecheck: all 20 tasks passed.
- Final production build: all four tasks passed after the source fixes.
- Final frozen-source unit suite: 1,526 tests passed across 196 files; 75 tests/18 files were skipped by their existing gates.
- Final full conventional disposable-PostgreSQL integration run: 77 tests passed across 16 files, including campaign authorization/idempotency, safe source-context serialization, concurrent challenge/shared-model budgets, publication ambiguity, catalog/discovery and actual worker progress/restart. All 36 migrations applied to the isolated database.
- Publication reconciliation: six additional focused tests passed, including hung verification, bounded concurrency, public evidence matching and no resubmission.
- All ten original affected browser journeys passed across seven specifications, followed by passing catalog and discovery journeys. After grounding changes, the final affected browser pair passed again: controlled campaign (22.9 seconds) and grounded discovery (26.7 seconds), against the actual local PostgreSQL/API/worker. Coverage includes review/edit/reapproval, pause/resume, independent fixture verification, terminal job states, offline/reconnect, catalog retry, candidate selection/dismissal, actual official-source references and reload.
- Final workspace lint checked 625 files with zero errors; six intentional CSS `!important` warnings remain. Final workspace check passed all 20 tasks.

These are local and controlled test results. They do not establish external provider, site or production success.

Final paid-model fault verification passed: a successful fake provider response followed by a failed draft write preserves the current fenced intent, reservation/day and observed cost, reaches an explicit ambiguous/needs_action state, and does not repeat the model call after worker restart. Successful research sources become verified; uncertain sources remain actionable. All 25 focused worker/research tests passed; no live paid request was made. Final consolidated reruns after this handler correction were interrupted by managed-session transitions without an exit result and are not counted as passes. The earlier full 16-file/74-test run remains valid evidence for its revision; final changed-backend PostgreSQL verification passed both targeted tests in a fresh disposable database after all 36 migrations: actual worker progress/restart across 70 blocked siblings, and campaign review handoff/safe DTO serialization.

## Official-site catalog and discovery status

Research Start now seeds the configured website without manual source entry. Each bounded catalog run preserves its website identity, crawl policy, page provenance and durable progress; reads do not generate contributions or call a model. Expected missing optional probes remain visible and retryable without becoming false mandatory blockers. Website changes fence unfinished old work and preserve history; an active research campaign queues its new website automatically.

Catalog validation passed four scoped PostgreSQL scenarios across API/DB and worker runs, 37 transport/parser tests, 34 worker/catalog tests and the focused UI regressions. The new catalog browser journey passed against the actual local API/database/worker: zero manual URLs, observed evidence, a blocked page followed by explicit retry, terminal progress and reload persistence. The existing controlled campaign journey also passed in the preceding pair run.

Community discovery is locally verified: the search and inspection adapters passed 18 focused tests, and campaign orchestration/candidate disposition passed all six scoped PostgreSQL scenarios across DB/API and worker runs. The corrected worker suite includes recovery from an earlier no-source summary, three-query and ten-candidate bounds, restart, and honest blocked-inspection evidence. The activity-contract mismatch exposed by browser verification is corrected: worker emission uses the shared event union and all three actual worker PostgreSQL scenarios now include successful snapshot serialization. The corrected catalog browser journey has passed. The discovery browser journey also passed (27.1 seconds), including a blocked candidate, explicit retry, selection, source-note draft, dismissal and persisted reload. Earlier failed runs are superseded, not counted as passes. The intended bounds are three evidence-derived queries and ten inspected candidates per catalog run; no paid drafting happens before explicit candidate selection. Passing fixture tests does not establish live search connectivity or site eligibility.

Managed development networking is a separate unresolved live check. The saved broader-access environment draft is not active; publish/load the environment settings through its interface before retesting. The management tool can save this draft but cannot publish it. This does not authorize application deployment. Built-in Node proxy success does not verify the catalog/search/inspection transport, which uses an explicit DNS-pinned dispatcher. Verify the actual adapters after network access is applied; preserve destination protections when designing any supported proxy transport.

Official-source grounding follow-on: the optional drafting contract/provider accepts at most three bounded, observed same-origin source excerpts and includes identical context in cost estimates and prompts. Provider tests passed (16); strict DTO PostgreSQL tests passed (2), and context/recovery UI tests passed (10). Worker integration is frozen with 15 focused tests and adapters type check/Biome passing, including stale-root rejection, identical estimated/supplied context and durable uncertainty recovery with one paid call. Final combined fresh-database verification passed all six campaign PostgreSQL scenarios across three files after all 36 migrations. Final full conventional integration passed 77 tests across 16 files, and the final controlled/grounded-discovery browser pair passed both tests. This is local controlled acceptance, not live model validation. Missing official evidence remains explicit and does not authorize unsupported project claims.
