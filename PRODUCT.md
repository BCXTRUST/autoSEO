# Link Builder

Create a project, click Start, and the worker posts on weekdays in the project's markets. A human
is needed only when a board asks for one.

## Setup

The wizard saves a draft at each step. Finish them in this order:

1. **Project.** Brand name and the domains the persona may link to.
2. **Markets.** Each market has a country, a locale, and a timezone.
3. **Persona.** Display name, language, and register. One persona per project.
4. **Captell.** Paste the token once. It is written to the encrypted secret store. The API never returns it.
5. **Proxy.** Endpoint template. IPRoyal is configured first, Oxylabs second. The host placeholder is `proxy.example` until a deployment replaces it.
6. **Mailbox.** With `AGENTMAIL_API_KEY`, the project gets an inbox. Without that key, the address is `lb-<projectId>@inbox.example`.
7. **Disclosure.** The default is `undisclosed_persona`. Other modes are off unless the customer chooses them.
8. **Start.** **Start building** records `responsibilityAck` (who accepted, and when). There is no checkbox.
9. **Schedule.** Weekdays only, inside the project's window.

## Models

Customers do not connect a model. The deployment holds `OPENROUTER_API_KEY`. Drafting and
classification use `google/gemini-3.8-flash`. A refusal falls back to `moonshotai/kimi-k3`.
Set `LINK_BUILDER_MODEL_DRAFT` to `anthropic/claude-fable-5` when a project needs the higher
writing tier. The in-app computer still uses `PI_DEFAULT_MODEL` (`x-ai/grok-4.6`).

## Browser

The persona browser runs inside the computer sandbox. Docker is the local provider. Daytona and E2B
use the same session contract when they are the selected sandbox provider: the worker starts
`rakazo-lb-browser serve` and passes each call in an environment variable.

The sandbox image is expected to include Node.js, `/usr/bin/chromium`, `rakazo-lb-browser` on
`PATH`, and a display for the operator live screen. A live Daytona or E2B sandbox has not been
verified from this repository.

Kernel is an optional browser. It is constructed only when `LINK_BUILDER_BROWSER=kernel` and
`LINK_BUILDER_KERNEL_SECRET_ID` are set. Calls are HTTPS. Credentials stay in the encrypted store
until a request. The operator live screen stays the sandbox display; Kernel is not wired into it.

## Plans

v1 does not bill. A static stub named `starter` caps a workspace at 3 projects, 3 personas (one per
project), and 10 counted live links per project per day. Stripe is not linked. Unsigned billing
webhooks are refused, and there is no billing endpoint.

## Canaries

These checks stay outside CI. Harold runs them; this document does not claim a result:

- Captell, against a test seat
- Identity on two boards
- The sandbox browser
- AgentMail inbound
- An https webhook

## Responsibility

Undisclosed commercial posts can be treated as unfair competition. Liability sits on the promoted
company and on the service that runs the posts. The dashboard does not show a warning banner. The
acceptance recorded on Start, and the terms the customer accepts, are where that is stated.
