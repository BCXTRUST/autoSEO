import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { BrowserSession, ClickableControl, FormFieldInfo } from "@rakazo/adapter-kit";
import {
  assertPacing,
  HUMAN_PACING,
  type PacingPolicy,
  pacedDelayMs,
  rateLimitWaitMs,
} from "@rakazo/linkbuilder-core";
import type { BrowserContext, BrowserType, Page, Request } from "playwright";
import { clickControl } from "./page-click.js";

/** Playwright resets its own action timeout when a page navigates, so a reloading board can wait forever. */
const ACTION_DEADLINE_MS = 12_000;
/**
 * How long a click waits for the board to answer a navigation it started. A registration POST
 * sends the activation mail before it answers, and a slow mail server can hold that for a long
 * time; every read in the meantime blocks on the pending navigation and would hit the deadline.
 */
const NAVIGATION_RESPONSE_MS = 90_000;
/** A navigation request shows up within milliseconds of the click when there is one. */
const NAVIGATION_DETECT_MS = 1_500;

function deadline<T>(work: Promise<T>, ms = ACTION_DEADLINE_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Browser action timed out")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("Browser action failed"));
      },
    );
  });
}

/**
 * `patchright` (default) is the drop-in Playwright fork that hides the CDP `Runtime.enable` leak.
 * `playwright` is the plain upstream driver, selected with `LINK_BUILDER_BROWSER_ENGINE=playwright`.
 * Both drive the same Playwright-bundled Chromium binary, because branded Chrome 137+ ignores
 * `--load-extension`.
 */
export type ChromiumEngine = "playwright" | "patchright";
/** `camoufox` launches Playwright Firefox with the Camoufox executable. It cannot load the Page Helper. */
export type BrowserEngine = ChromiumEngine | "camoufox";

export class BrowserEngineUnavailable extends Error {
  readonly code = "unavailable" as const;
  readonly engine: BrowserEngine;

  constructor(engine: BrowserEngine) {
    super(`Browser engine ${engine} is unavailable`);
    this.name = "BrowserEngineUnavailable";
    this.engine = engine;
  }
}

export interface BrowserProxy {
  /** `host:port`; Chromium's `--proxy-server` takes the scheme from the URL when present. */
  server: string;
  username?: string;
  password?: string;
}

export interface PlaywrightLaunchOptions {
  profileDir: string;
  /** Unpacked MV3 extension directories, e.g. the Page Helper. */
  helperDirs?: readonly string[];
  locale: string;
  timezoneId: string;
  acceptLanguage?: string;
  proxy?: BrowserProxy;
  /** Defaults to headed when `DISPLAY` is set, so the live screen shows the real browser. */
  headless?: boolean;
  pacing?: PacingPolicy;
  random?: () => number;
  /** A system Chromium (the sandbox image ships `/usr/bin/chromium`); the bundled one otherwise. */
  executablePath?: string;
  engine?: BrowserEngine;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) =>
  ms <= 0 ? Promise.resolve() : new Promise<void>((resolve) => setTimeout(resolve, ms));

const ENGINE_MODULES: Record<ChromiumEngine, string> = {
  playwright: "playwright",
  patchright: "patchright",
};

async function loadChromium(engine: ChromiumEngine): Promise<BrowserType> {
  const specifier = ENGINE_MODULES[engine];
  const module = (await import(specifier)) as { chromium?: BrowserType };
  if (!module.chromium) throw new Error(`Browser engine ${engine} has no chromium launcher`);
  return module.chromium;
}

export function browserEngineFromEnv(env: NodeJS.ProcessEnv = process.env): ChromiumEngine {
  return env.LINK_BUILDER_BROWSER_ENGINE === "playwright" ? "playwright" : "patchright";
}

/** Camoufox is optional. A missing executable is `unavailable`, not a failed Chromium launch. */
export function camoufoxExecutable(
  env: NodeJS.ProcessEnv = process.env,
  path?: string,
): string | null {
  const executable = path ?? env.LINK_BUILDER_CAMOUFOX_PATH;
  if (!executable || !existsSync(executable)) return null;
  return executable;
}

/** Playwright's bundled Chromium; Patchright pins its own revision, which is not installed. */
export async function bundledChromiumPath(): Promise<string> {
  return (await loadChromium("playwright")).executablePath();
}

function proxyServer(server: string): string {
  return /^[a-z0-9]+:\/\//i.test(server) ? server : `http://${server}`;
}

export class PlaywrightBrowserSession implements BrowserSession {
  readonly id = randomUUID();
  private readonly pacing: PacingPolicy;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly actions: number[] = [];
  private closed = false;
  private lastNavigation: { status: number | null; headers: Record<string, string> } | null = null;

  constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
    options: Pick<PlaywrightLaunchOptions, "pacing" | "random" | "sleep" | "now"> = {},
  ) {
    this.pacing = assertPacing(options.pacing ?? HUMAN_PACING);
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.page.setDefaultTimeout(8_000);
    this.page.setDefaultNavigationTimeout(20_000);
  }

  private async paceAction(): Promise<void> {
    const wait = rateLimitWaitMs(this.actions, this.now(), this.pacing.maxActionsPerMinute);
    await this.sleep(wait + pacedDelayMs(this.pacing.beforeAction, this.random));
    this.actions.push(this.now());
    const windowStart = this.now() - 60_000;
    while (this.actions.length > 0 && this.actions[0]! <= windowStart) this.actions.shift();
  }

  private first(selector: string) {
    return this.page.locator(selector).first();
  }

  async goto(url: string): Promise<void> {
    await this.paceAction();
    const response = await deadline(
      this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 12_000 }),
    );
    this.lastNavigation = response
      ? { status: response.status(), headers: response.headers() }
      : { status: null, headers: {} };
  }

  async navigationMeta(): Promise<{ status: number | null; headers: Record<string, string> }> {
    return this.lastNavigation ?? { status: null, headers: {} };
  }

  /** Locale and time zone the live page is actually using. */
  async browserFacts(): Promise<{ locale: string; timezoneId: string }> {
    return this.page.evaluate(() => {
      const root = globalThis as {
        navigator: { language: string };
        Intl: { DateTimeFormat: () => { resolvedOptions: () => { timeZone: string } } };
      };
      return {
        locale: root.navigator.language,
        timezoneId: root.Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
    });
  }

  async url(): Promise<string> {
    return this.page.url();
  }

  async fill(selector: string, text: string, options: { secret?: boolean } = {}): Promise<void> {
    await this.paceAction();
    const visible = this.page.locator(selector).locator("visible=true");
    const field = (await visible.count()) > 0 ? visible.first() : this.first(selector);
    try {
      // A moving captcha frame or a banner can block the focus click. The value still lands.
      await deadline(field.fill(text, { timeout: 8_000 }));
    } catch (error) {
      try {
        await deadline(field.fill(text, { force: true, timeout: 8_000 }));
      } catch {
        if (options.secret) throw new Error(`Could not fill ${selector}`);
        throw error;
      }
    }
  }

  private watchNavigation(): Promise<Request | null> {
    return this.page
      .waitForRequest(
        (request) => request.isNavigationRequest() && request.frame() === this.page.mainFrame(),
        { timeout: NAVIGATION_DETECT_MS },
      )
      .catch(() => null);
  }

  private async settleNavigation(request: Request | null): Promise<void> {
    if (!request) return;
    await Promise.race([
      request.response().catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), NAVIGATION_RESPONSE_MS)),
    ]);
    await this.page
      .waitForLoadState("domcontentloaded", { timeout: ACTION_DEADLINE_MS })
      .catch(() => undefined);
  }

  async click(selector: string): Promise<void> {
    await this.paceAction();
    const navigation = this.watchNavigation();
    // Click in the page. Playwright's actionability check waits until a captcha iframe stops
    // moving, which it does not, so a submit that already landed is reported as a timeout.
    const clicked = this.page.evaluate(clickControl, selector)
      // A rejected evaluate here means the click started a navigation that destroyed the page
      // context; the click itself has already landed, so it must not be sent again.
      .catch(() => true);
    // The same navigation can also keep the evaluate from ever resolving. The caller waits for
    // the result panel.
    const ok = await Promise.race([
      clicked,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 1_500)),
    ]);
    if (ok === false) {
      await deadline(
        this.first(selector).click({ timeout: 4_000, noWaitAfter: true, force: true }),
      );
    }
    await this.settleNavigation(await navigation);
  }

  async text(selector: string): Promise<string | null> {
    const locator = this.first(selector);
    if ((await deadline(locator.count())) === 0) return null;
    const value = await deadline(
      locator.evaluate((element) => (element.textContent ?? "").replace(/\s+/g, " ").trim()),
    );
    return value || null;
  }

  async exists(selector: string): Promise<boolean> {
    return (await deadline(this.page.locator(selector).count())) > 0;
  }

  async isVisible(selector: string): Promise<boolean> {
    return (await this.page.locator(selector).locator("visible=true").count()) > 0;
  }

  async isChecked(selector: string): Promise<boolean> {
    const locator = this.first(selector);
    if ((await locator.count()) === 0) return false;
    return locator.isChecked();
  }

  async attribute(selector: string, name: string): Promise<string | null> {
    const locator = this.first(selector);
    if ((await deadline(locator.count())) === 0) return null;
    return deadline(locator.getAttribute(name));
  }

  async elementScreenshotPng(
    selector: string,
    options?: { paddingPx?: number; insetPx?: number },
  ): Promise<Uint8Array> {
    const padding = options?.paddingPx ?? 0;
    const inset = options?.insetPx ?? 0;
    const locator = this.first(selector);
    if (padding <= 0 && inset <= 0)
      return new Uint8Array(await locator.screenshot({ type: "png" }));
    const box = await locator.boundingBox();
    if (!box) throw new Error(`Could not crop ${selector}`);
    const viewport = this.page.viewportSize() ?? { width: 1280, height: 720 };
    const x = Math.max(0, Math.floor(inset > 0 ? box.x + inset : box.x - padding));
    const y = Math.max(0, Math.floor(inset > 0 ? box.y + inset : box.y - padding));
    const right = Math.min(
      viewport.width,
      Math.ceil(inset > 0 ? box.x + box.width - inset : box.x + box.width + padding),
    );
    const bottom = Math.min(
      viewport.height,
      Math.ceil(inset > 0 ? box.y + box.height - inset : box.y + box.height + padding),
    );
    return new Uint8Array(
      await this.page.screenshot({
        type: "png",
        clip: { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) },
      }),
    );
  }

  async injectToken(fieldName: string, token: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(fieldName)) throw new Error("Unexpected captcha field");
    try {
      await this.page.evaluate(
        ({ name, value }) => {
          interface TokenField {
            value?: string;
            closest?: (selector: string) => TokenForm | null;
          }
          interface TokenForm {
            appendChild: (node: TokenField) => void;
          }
          const root = globalThis as unknown as {
            document: {
              querySelectorAll: (selector: string) => Iterable<TokenField>;
              querySelector: (selector: string) =>
                | (TokenField &
                    TokenForm & {
                      getAttribute: (attribute: string) => string | null;
                    })
                | null;
              createElement: (tag: string) => TokenField & {
                type?: string;
                name?: string;
              };
            };
          };
          const fields = [...root.document.querySelectorAll(`[name="${name}"]`)];
          if (fields.length === 0) {
            const host = root.document.querySelector(
              "[data-xf-init='turnstile'], .cf-turnstile, .g-recaptcha, .h-captcha",
            );
            const form =
              host?.closest?.("form") ??
              root.document.querySelector("form:has(input[type='password'])") ??
              root.document.querySelector("form");
            if (form) {
              const input = root.document.createElement("input");
              input.type = "hidden";
              input.name = name;
              input.value = value;
              form.appendChild(input);
              fields.push(input);
            }
          }
          for (const field of fields) {
            field.value = value;
          }
          const callback = root.document
            .querySelector("[data-callback]")
            ?.getAttribute("data-callback");
          if (callback && /^[A-Za-z_$][\w$]*$/.test(callback)) {
            const fn = (globalThis as Record<string, unknown>)[callback];
            if (typeof fn === "function") (fn as (token: string) => void)(value);
          }
        },
        { name: fieldName, value: token },
      );
    } catch {
      throw new Error(`Could not place the captcha token in ${fieldName}`);
    }
  }

  async extensionVersions(): Promise<Array<{ id: string; version: string }>> {
    let workers = this.context.serviceWorkers();
    if (workers.length === 0) {
      try {
        await this.context.waitForEvent("serviceworker", { timeout: 5_000 });
      } catch {
        return [];
      }
      workers = this.context.serviceWorkers();
    }
    const found: Array<{ id: string; version: string }> = [];
    for (const worker of workers) {
      const id = /^chrome-extension:\/\/([a-p]{32})\//.exec(worker.url())?.[1];
      if (!id) continue;
      let version = "";
      try {
        version = await worker.evaluate(() => {
          const runtime = (
            globalThis as {
              chrome?: { runtime?: { getManifest?: () => { version?: string } } };
            }
          ).chrome?.runtime;
          return runtime?.getManifest?.().version ?? "";
        });
      } catch {
        version = "";
      }
      found.push({ id, version });
    }
    return found;
  }

  async ariaSnapshot(): Promise<string> {
    return this.page.locator("body").ariaSnapshot();
  }

  async pageText(): Promise<string> {
    return deadline(this.page.locator("body").innerText({ timeout: 8_000 }));
  }

  async listText(selector: string): Promise<string[]> {
    const texts = await deadline(this.page.locator(selector).allTextContents());
    return texts.map((text) => text.replace(/\s+/g, " ").trim()).filter(Boolean);
  }

  async listAnchors(selector: string): Promise<Array<{ text: string; href: string }>> {
    return this.page.evaluate((rootSelector) => {
      const root = globalThis as unknown as {
        document: { querySelectorAll: (selector: string) => Iterable<Element> };
      };
      interface Element {
        textContent: string | null;
        getAttribute: (name: string) => string | null;
      }
      const anchors: Array<{ text: string; href: string }> = [];
      for (const el of root.document.querySelectorAll(rootSelector)) {
        const href = el.getAttribute("href");
        const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
        if (!href || !text) continue;
        anchors.push({ text, href });
        if (anchors.length >= 20) break;
      }
      return anchors;
    }, selector);
  }

  async drag(sourceSelector: string, targetSelector: string): Promise<void> {
    await this.paceAction();
    await deadline(
      this.page.locator(sourceSelector).first().dragTo(this.page.locator(targetSelector).first(), {
        timeout: 4_000,
        force: true,
      }),
    );
  }

  async clickables(): Promise<ClickableControl[]> {
    return this.page.evaluate(() => {
      const quote = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      interface El {
        id: string;
        tagName: string;
        textContent: string | null;
        getAttribute: (name: string) => string | null;
        hasAttribute: (name: string) => boolean;
        closest: (selector: string) => El | null;
        setAttribute: (name: string, value: string) => void;
        getClientRects: () => { length: number };
        ownerDocument: {
          defaultView: {
            getComputedStyle: (el: El) => { display: string; visibility: string };
          } | null;
        };
      }
      const root = globalThis as unknown as {
        document: { querySelectorAll: (selector: string) => Iterable<El> };
      };
      const controls: ClickableControl[] = [];
      let generated = 0;
      for (const el of root.document.querySelectorAll(
        "a, button, [role='link'], [role='button'], [role='menuitem']",
      )) {
        const text = (
          (el.textContent ?? "").replace(/\s+/g, " ").trim() ||
          (el.getAttribute("aria-label") ?? "").replace(/\s+/g, " ").trim() ||
          (el.getAttribute("title") ?? "").replace(/\s+/g, " ").trim()
        );
        if (!text || text.length > 80) continue;
        const view = el.ownerDocument.defaultView;
        const style = view ? view.getComputedStyle(el) : null;
        if (
          el.hasAttribute("hidden") ||
          el.getAttribute("aria-hidden") === "true" ||
          style?.display === "none" ||
          style?.visibility === "hidden" ||
          el.getClientRects().length === 0
        ) {
          continue;
        }
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute("type") ?? "").toLowerCase() || null;
        const role = el.getAttribute("role");
        const href = el.getAttribute("href");
        const id = el.id;
        let selector: string;
        if (id && /^[A-Za-z][\w-]*$/.test(id)) selector = `#${id}`;
        else if (href) selector = `${tag}[href="${quote(href)}"]`;
        else {
          generated += 1;
          el.setAttribute("data-rakazo-click", String(generated));
          selector = `[data-rakazo-click="${generated}"]`;
        }
        controls.push({
          selector,
          tag,
          role,
          type,
          text,
          href,
          inHeader: Boolean(
            el.closest(
              "header, nav, [role='banner'], [role='navigation'], .navbar, .headerbar, #page-header",
            ),
          ),
        });
      }
      return controls;
    });
  }

  async formFields(selector: string): Promise<FormFieldInfo[]> {
    return this.page.evaluate((rootSelector) => {
      const cssEscape = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "\\$&");
      const rootDoc = globalThis as unknown as {
        document: {
          querySelector: (selector: string) => DomNode | null;
          querySelectorAll: (selector: string) => Iterable<DomNode>;
        };
      };
      interface DomNode {
        matches: (selector: string) => boolean;
        querySelector: (selector: string) => DomNode | null;
        querySelectorAll: (selector: string) => Iterable<DomNode>;
        closest: (selector: string) => DomNode | null;
        id: string;
        tagName: string;
        textContent: string | null;
        getAttribute: (name: string) => string | null;
        setAttribute: (name: string, value: string) => void;
        hasAttribute: (name: string) => boolean;
        getClientRects: () => { length: number };
      }
      const hasControl = (form: DomNode, probe: string) => {
        try {
          return form.querySelector(probe) !== null;
        } catch {
          return false;
        }
      };
      const accountForm = () => {
        const forms = [...rootDoc.document.querySelectorAll("form")];
        let best: DomNode | null = null;
        let bestScore = 0;
        for (const candidate of forms) {
          const action = (candidate.getAttribute("action") ?? "").toLowerCase();
          let score = 1;
          if (
            hasControl(candidate, "input[type='password']") &&
            (hasControl(candidate, "input[type='email']") ||
              hasControl(candidate, "input[name='email']"))
          ) {
            score = 100;
          } else if (
            hasControl(candidate, "input[name='agreed']") ||
            hasControl(candidate, "input[name='not_agreed']") ||
            hasControl(candidate, "#agreed") ||
            candidate.id === "agreement"
          ) {
            score = 80;
          } else if (action.includes("mode=register") || action.includes("register")) {
            score = 70;
          } else if (hasControl(candidate, "textarea")) {
            score = 60;
          } else if (
            hasControl(candidate, "input[type='password']") &&
            hasControl(candidate, "input[name*='mail' i], input[name*='Mail']")
          ) {
            score = 95;
          } else if (
            hasControl(candidate, "input[name*='_Check'], input[name*='_two'], input[name*='_check']")
          ) {
            score = 92;
          } else if (hasControl(candidate, "input[type='password']")) {
            score = 50;
          } else if (hasControl(candidate, "input[type='email']")) {
            score = 40;
          }
          if (score > bestScore) {
            best = candidate;
            bestScore = score;
          }
        }
        return best;
      };
      const root =
        rootSelector === "form" ? accountForm() : rootDoc.document.querySelector(rootSelector);
      if (!root) return [];
      const form = root.matches("form") ? root : root.querySelector("form");
      const scope = form ?? root;
      let generated = 0;
      return [...scope.querySelectorAll("input, textarea, select, button")].map((el) => {
        const id = el.id || null;
        const name = el.getAttribute("name");
        const tag = el.tagName.toLowerCase();
        const labelFor = id
          ? rootDoc.document.querySelector(`label[for="${cssEscape(id)}"]`)
          : null;
        const parent = el.closest("label");
        const own =
          tag === "button" || el.getAttribute("type") === "submit"
            ? el.textContent || el.getAttribute("value") || ""
            : "";
        const row = el.closest("li, dd, .field, .formRow, .form-row");
        const rowLabel = (row?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 180);
        const label = (
          labelFor?.textContent ||
          parent?.textContent ||
          el.getAttribute("aria-label") ||
          own ||
          rowLabel ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim();
        let control: string;
        if (id) control = `#${cssEscape(id)}`;
        else if (name) control = `[name="${cssEscape(name)}"]`;
        else {
          generated += 1;
          el.setAttribute("data-rakazo-field", String(generated));
          control = `[data-rakazo-field="${generated}"]`;
        }
        const type = el.getAttribute("type");
        const fieldset = el.closest("fieldset");
        const legend = fieldset?.querySelector("legend");
        const style = el.getAttribute("style") ?? "";
        const rowText = (el.closest(".formRow, .form-row")?.textContent ?? "")
          .replace(/\s+/g, " ")
          .toLowerCase();
        const decoy =
          /bitte lasse dieses feld frei|leave this field (?:blank|empty)|do not fill/.test(rowText);
        const options =
          tag === "select"
            ? [...el.querySelectorAll("option")].map((option) => ({
                value: option.getAttribute("value") ?? (option.textContent ?? "").trim(),
                label: (option.textContent ?? "").replace(/\s+/g, " ").trim(),
              }))
            : undefined;
        return {
          selector: control,
          tag,
          type,
          name,
          id,
          autocomplete: el.getAttribute("autocomplete"),
          label,
          role: el.getAttribute("role") ?? (tag === "textarea" ? "textbox" : null),
          required: el.hasAttribute("required") || Boolean(el.closest(".required")),
          placeholder: el.getAttribute("placeholder"),
          group: legend?.textContent?.replace(/\s+/g, " ").trim() || null,
          hidden:
            type === "hidden" ||
            el.hasAttribute("hidden") ||
            /display\s*:\s*none/i.test(style) ||
            el.getClientRects().length === 0 ||
            Boolean(el.closest(".formRow--limited")) ||
            decoy,
          value: el.getAttribute("value"),
          options,
        };
      });
    }, selector);
  }

  async waitFor(selector: string, options: { timeoutMs: number }): Promise<boolean> {
    try {
      await deadline(
        this.first(selector).waitFor({ state: "attached", timeout: options.timeoutMs }),
        options.timeoutMs + 2_000,
      );
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "TimeoutError" || error.message === "Browser action timed out")
      ) {
        return false;
      }
      throw error;
    }
  }

  /**
   * The consent control can sit in a frame that page text never includes. Look at the
   * screenshot, then click the visible accept control in whichever frame shows it.
   */
  async clickConsent(): Promise<boolean> {
    await this.screenshotPng().catch(() => undefined);
    const accept =
      /^(?:akzeptieren(?: und weiter)?|alle akzeptieren|alle cookies akzeptieren|cookies akzeptieren|zustimmen|einverstanden|ich stimme zu|accept(?: all| and continue)?|agree(?: and continue)?)$/i;
    const reject =
      /werbefrei|ablehnen|einstellungen|contentpass|3[,.]99|reject|settings|manage|nur notwendige|necessary only/i;
    for (const frame of this.page.frames()) {
      const clicked = await frame
        .evaluate(
          ({ acceptSource, rejectSource }) => {
            interface NodeLike {
              innerText?: string;
              shadowRoot?: ParentLike | null;
              getAttribute: (name: string) => string | null;
              hasAttribute: (name: string) => boolean;
              getClientRects: () => { length: number };
              click: () => void;
              ownerDocument: {
                defaultView: { getComputedStyle: (el: NodeLike) => { display: string; visibility: string } } | null;
              };
            }
            interface ParentLike {
              querySelectorAll: (selector: string) => Iterable<NodeLike>;
            }
            const acceptRe = new RegExp(acceptSource, "i");
            const rejectRe = new RegExp(rejectSource, "i");
            const doc = (globalThis as unknown as { document: ParentLike }).document;
            const seen = new Set<NodeLike>();
            const controls: Array<{ el: NodeLike; text: string }> = [];
            const visit = (root: ParentLike) => {
              for (const el of root.querySelectorAll(
                "button, a, [role='button'], input[type='button'], input[type='submit']",
              )) {
                if (seen.has(el)) continue;
                seen.add(el);
                const text = (el.innerText || el.getAttribute("value") || el.getAttribute("aria-label") || "")
                  .replace(/\s+/g, " ")
                  .trim();
                if (!text || text.length > 80 || rejectRe.test(text) || !acceptRe.test(text)) continue;
                const style = el.ownerDocument.defaultView?.getComputedStyle(el);
                if (
                  el.hasAttribute("hidden") ||
                  style?.display === "none" ||
                  style?.visibility === "hidden" ||
                  el.getClientRects().length === 0
                ) {
                  continue;
                }
                controls.push({ el, text });
              }
              for (const el of root.querySelectorAll("*")) {
                if (el.shadowRoot) visit(el.shadowRoot);
              }
            };
            visit(doc);
            const chosen = controls.sort((a, b) => b.text.length - a.text.length)[0];
            if (!chosen) return false;
            chosen.el.click();
            return true;
          },
          { acceptSource: accept.source, rejectSource: reject.source },
        )
        .catch(() => false);
      if (clicked) return true;
    }
    return false;
  }

  async screenshotPng(): Promise<Uint8Array> {
    return new Uint8Array(await this.page.screenshot({ type: "png" }));
  }

  async loadedExtensions(): Promise<string[]> {
    let workers = this.context.serviceWorkers();
    if (workers.length === 0) {
      try {
        await this.context.waitForEvent("serviceworker", { timeout: 5_000 });
      } catch {
        return [];
      }
      workers = this.context.serviceWorkers();
    }
    const ids = workers
      .map((worker) => /^chrome-extension:\/\/([a-p]{32})\//.exec(worker.url())?.[1])
      .filter((id): id is string => id !== undefined);
    return [...new Set(ids)];
  }

  /** Fires once when the browser goes away, including when something outside kills Chromium. */
  onClosed(listener: () => void): void {
    this.context.once("close", listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.context.close();
  }
}

/** Identity fields passed to Playwright. Geolocation is never set. */
export function identityLaunchFields(options: PlaywrightLaunchOptions): {
  locale: string;
  timezoneId: string;
  extraHTTPHeaders?: { "Accept-Language": string };
  proxy?: { server: string; username?: string; password?: string };
} {
  return {
    locale: options.locale,
    timezoneId: options.timezoneId,
    ...(options.acceptLanguage
      ? { extraHTTPHeaders: { "Accept-Language": options.acceptLanguage } }
      : {}),
    ...(options.proxy
      ? {
          proxy: {
            server: proxyServer(options.proxy.server),
            username: options.proxy.username,
            password: options.proxy.password,
          },
        }
      : {}),
  };
}

/**
 * Launches a persistent profile. Chromium loads the Page Helper. Camoufox is Firefox with
 * the executable from config; without that file the engine is unavailable and no browser starts.
 * Branded Chrome 137+ ignores `--load-extension`, so Chromium is the bundled one unless a
 * system Chromium is given.
 */
export async function launchPlaywrightSession(
  options: PlaywrightLaunchOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PlaywrightBrowserSession> {
  const engine = options.engine ?? browserEngineFromEnv(env);
  const helperDirs = engine === "camoufox" ? [] : (options.helperDirs ?? []);
  const args = [
    ...(helperDirs.length > 0
      ? [
          `--disable-extensions-except=${helperDirs.join(",")}`,
          `--load-extension=${helperDirs.join(",")}`,
        ]
      : []),
    // A restored crash bubble sits over the forum form and the controlled page stops answering.
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--disable-infobars",
    // Chromium skips the proxy for loopback unless this token removes that bypass.
    ...(options.proxy ? ["--proxy-bypass-list=<-loopback>"] : []),
  ];
  const identity = identityLaunchFields(options);
  const context =
    engine === "camoufox"
      ? await launchCamoufox(options, env, args, identity)
      : await launchChromium(options, env, engine, args, identity);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    return new PlaywrightBrowserSession(context, page, options);
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function launchChromium(
  options: PlaywrightLaunchOptions,
  env: NodeJS.ProcessEnv,
  engine: ChromiumEngine,
  args: string[],
  identity: ReturnType<typeof identityLaunchFields>,
): Promise<BrowserContext> {
  const chromium = await loadChromium(engine);
  const executablePath =
    options.executablePath ?? (engine === "patchright" ? await bundledChromiumPath() : undefined);
  return chromium.launchPersistentContext(options.profileDir, {
    ...(executablePath ? { executablePath } : { channel: "chromium" }),
    headless: options.headless ?? !env.DISPLAY,
    args,
    viewport: { width: 1280, height: 860 },
    acceptDownloads: false,
    ...identity,
  });
}

async function launchCamoufox(
  options: PlaywrightLaunchOptions,
  env: NodeJS.ProcessEnv,
  args: string[],
  identity: ReturnType<typeof identityLaunchFields>,
): Promise<BrowserContext> {
  const executablePath = camoufoxExecutable(env, options.executablePath);
  if (!executablePath) throw new BrowserEngineUnavailable("camoufox");
  const playwright = (await import("playwright")) as { firefox?: BrowserType };
  if (!playwright.firefox) throw new BrowserEngineUnavailable("camoufox");
  return playwright.firefox.launchPersistentContext(options.profileDir, {
    executablePath,
    headless: options.headless ?? !env.DISPLAY,
    args,
    viewport: { width: 1280, height: 860 },
    acceptDownloads: false,
    ...identity,
  });
}
