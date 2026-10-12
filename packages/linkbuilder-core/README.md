# @rakazo/linkbuilder-core

Pure Link Builder domain logic: no I/O, no clocks, no randomness, no vendor SDKs. Every
function takes its inputs (including `now`) as arguments, so the worker, the API and tests get
identical answers.

| Module | What it decides |
| --- | --- |
| `host-state` | Host lifecycle transitions, including park and resume back to `parkedFrom`. |
| `run-state` | Daily run transitions and counters (`liveToday`, `liveWeek`, registrations). |
| `placement-state` | Placement transitions and the verdict from a logged-out verification fetch. |
| `captcha-helper-machine` | Next action for the in-page captcha helper, driven by its button label. |
| `schedule` | Local date key and whether the project's window or overtime is open. |
| `funnel` | Today's link attempts and registrations, and the end-of-window why-not report. |
| `market` | Which markets to work under `marketPolicy`, and the per-country proxy sticky key. |
| `policy` | Target URL, anchor, claim, link-ratio and single-link checks; reference insertion. |
| `plan` | Plan caps (`projects`, `live_per_day`, `personas`) before a start or a counted placement. |
| `webhooks` | HMAC signatures, and which outbound URLs are allowed. |

Illegal transitions throw `IllegalTransition`; invalid counts throw `RangeError`.

Not in this package: persistence (`@rakazo/db`), board drivers, browser sessions, captcha
solving, search, mail and models (adapters behind the `@rakazo/adapter-kit` contracts), and
scheduling of jobs (the worker).
