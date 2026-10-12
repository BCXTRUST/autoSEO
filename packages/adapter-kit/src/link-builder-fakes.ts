import type { z } from "zod";
import {
  type BrowserPersona,
  BrowserPersonaSchema,
  type BrowserSession,
  type BrowserSessionCapabilities,
  type BrowserSessionProvider,
  type CaptchaBalance,
  type CaptchaQuestionRequest,
  CaptchaQuestionRequestSchema,
  type CaptchaQuestionResult,
  type CaptchaSolveRequest,
  type CaptchaSolveResult,
  type CaptchaSolver,
  type CaptchaSolverCapabilities,
  CaptchaSolverError,
  type CaptchaType,
  type CountryCode,
  type FormFieldInfo,
  type InboundMail,
  InboundMailSchema,
  LINK_BUILDER_CONTRACT_VERSION,
  type MailboxInbox,
  type MailboxProvider,
  type MailboxProviderCapabilities,
  type ModelLane,
  type ProxyEndpoint,
  ProxyEndpointSchema,
  type ProxyKind,
  type ProxyLeaseRequest,
  ProxyLeaseRequestSchema,
  type ProxyProvider,
  type ProxyProviderCapabilities,
  parseCaptchaSolveRequest,
  type SearchProvider,
  type SearchProviderCapabilities,
  type TextModel,
  type TextModelCapabilities,
  type TextModelRequest,
  type TextModelResult,
  type TokenCaptchaType,
  type WebSearchRequest,
  WebSearchRequestSchema,
  type WebSearchResult,
} from "./link-builder.js";
import type { AdapterContext, AdapterDescriptor } from "./types.js";

function descriptor<T>(id: string, capabilities: T): AdapterDescriptor<T> {
  return {
    id,
    contractVersion: LINK_BUILDER_CONTRACT_VERSION,
    adapterVersion: "fake",
    capabilities,
  };
}

function throwIfAborted(context: AdapterContext): void {
  if (context.signal.aborted) throw new Error("Operation aborted");
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Deterministic PNG-signed bytes of the requested size for tests. */
export function fakePngBytes(size: number, seed = ""): Uint8Array {
  const bytes = new Uint8Array(Math.max(size, PNG_SIGNATURE.length));
  bytes.set(PNG_SIGNATURE);
  for (let index = PNG_SIGNATURE.length; index < bytes.length; index++) {
    bytes[index] = seed.length ? seed.charCodeAt(index % seed.length) & 0xff : 0;
  }
  return bytes;
}

export interface FakeElement {
  text?: string;
  attributes?: Record<string, string>;
  /** Value typed by `fill`. */
  value?: string;
  /** Present in the DOM but not shown, such as a dismissed cookie bar. */
  hidden?: boolean;
  /** Checkbox or radio state. A click toggles it. */
  checked?: boolean;
  png?: Uint8Array;
  /** Used when a crop asks for padding. Falls back to `png`. */
  paddedPng?: Uint8Array;
  /** Closer crops, consumed in order when `insetPx` is set. */
  closerPngs?: Uint8Array[];
  onClick?: (page: FakePageController) => void;
}

export interface FakePage {
  /** Full page text; defaults to the joined text of all elements. */
  text?: string;
  elements: Record<string, FakeElement>;
  /** Explicit form controls. Returned by `formFields` when the selector matches. */
  formFields?: FormFieldInfo[];
  /** Runs before each `waitFor`, letting a script advance asynchronous page state. */
  onTick?: (page: FakePageController) => void;
}

export interface FakePageController {
  readonly url: string;
  goto(url: string): void;
  get(selector: string): FakeElement | undefined;
  set(selector: string, element: FakeElement | undefined): void;
  setText(selector: string, text: string): void;
  setPageText(text: string | undefined): void;
}

export type FakeBrowserAction =
  | { kind: "goto"; url: string }
  | { kind: "fill"; selector: string; value: string }
  | { kind: "click"; selector: string }
  | { kind: "close" };

export const FAKE_SECRET_MASK = "[secret]";

function clonePage(page: FakePage): FakePage {
  const elements: Record<string, FakeElement> = {};
  for (const [selector, element] of Object.entries(page.elements)) {
    elements[selector] = {
      ...element,
      attributes: element.attributes ? { ...element.attributes } : undefined,
      closerPngs: element.closerPngs ? [...element.closerPngs] : undefined,
    };
  }
  return { ...page, elements, formFields: page.formFields?.map((field) => ({ ...field })) };
}

export class FakeBrowserSession implements BrowserSession {
  readonly actions: FakeBrowserAction[] = [];
  readonly screenshots: Array<{ selector: string; paddingPx?: number; insetPx?: number }> = [];
  private readonly pages = new Map<string, FakePage>();
  private currentUrl = "about:blank";
  private closed = false;

  constructor(
    readonly id: string,
    readonly persona: BrowserPersona,
    site: Record<string, FakePage>,
  ) {
    for (const [url, page] of Object.entries(site)) this.pages.set(url, clonePage(page));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async goto(url: string): Promise<void> {
    this.assertOpen();
    this.actions.push({ kind: "goto", url });
    this.navigate(url);
  }

  async url(): Promise<string> {
    this.assertOpen();
    return this.currentUrl;
  }

  async fill(selector: string, text: string, options?: { secret?: boolean }): Promise<void> {
    const element = this.require(selector);
    element.value = text;
    this.actions.push({ kind: "fill", selector, value: options?.secret ? FAKE_SECRET_MASK : text });
  }

  async click(selector: string): Promise<void> {
    const element = this.require(selector);
    this.actions.push({ kind: "click", selector });
    if (element.checked !== undefined) element.checked = !element.checked;
    element.onClick?.(this.controller());
  }

  async text(selector: string): Promise<string | null> {
    this.assertOpen();
    const element = this.page().elements[selector];
    return element ? (element.text ?? "") : null;
  }

  async exists(selector: string): Promise<boolean> {
    this.assertOpen();
    return selector in this.page().elements;
  }

  async isVisible(selector: string): Promise<boolean> {
    this.assertOpen();
    const element = this.page().elements[selector];
    return Boolean(element) && element.hidden !== true;
  }

  async isChecked(selector: string): Promise<boolean> {
    this.assertOpen();
    return this.page().elements[selector]?.checked === true;
  }

  async attribute(selector: string, name: string): Promise<string | null> {
    this.assertOpen();
    return this.page().elements[selector]?.attributes?.[name] ?? null;
  }

  async elementScreenshotPng(
    selector: string,
    options?: { paddingPx?: number; insetPx?: number },
  ): Promise<Uint8Array> {
    this.screenshots.push({
      selector,
      paddingPx: options?.paddingPx,
      insetPx: options?.insetPx,
    });
    const element = this.require(selector);
    if (options?.insetPx && element.closerPngs && element.closerPngs.length > 0) {
      const closer = element.closerPngs.shift();
      if (closer) return closer;
    }
    if (options?.paddingPx && element.paddedPng) return element.paddedPng;
    return element.png ?? fakePngBytes(256, `${selector}:${element.text ?? ""}`);
  }

  async injectToken(fieldName: string, token: string): Promise<void> {
    this.assertOpen();
    const selector = `[name='${fieldName}']`;
    const element = this.page().elements[selector];
    if (!element) throw new Error(`Could not place the captcha token in ${fieldName}`);
    element.value = token;
    this.actions.push({ kind: "fill", selector, value: FAKE_SECRET_MASK });
  }

  async formFields(selector: string): Promise<FormFieldInfo[]> {
    this.assertOpen();
    if (!(selector in this.page().elements) && !this.page().formFields) return [];
    return (this.page().formFields ?? []).map((field) => ({ ...field }));
  }

  async pageText(): Promise<string> {
    this.assertOpen();
    const page = this.page();
    if (page.text !== undefined) return page.text;
    return Object.values(page.elements)
      .map((element) => element.text ?? "")
      .filter(Boolean)
      .join("\n");
  }

  async waitFor(selector: string, _options: { timeoutMs: number }): Promise<boolean> {
    this.assertOpen();
    this.page().onTick?.(this.controller());
    return this.exists(selector);
  }

  async screenshotPng(): Promise<Uint8Array> {
    this.assertOpen();
    return fakePngBytes(1024, this.currentUrl);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.actions.push({ kind: "close" });
  }

  /** Test helper: the value typed into a field, including secrets that the action log masks. */
  valueOf(selector: string): string | undefined {
    return this.page().elements[selector]?.value;
  }

  private navigate(url: string): void {
    this.currentUrl = url;
    if (!this.pages.has(url)) this.pages.set(url, { text: "", elements: {} });
  }

  private page(): FakePage {
    const page = this.pages.get(this.currentUrl);
    if (!page) {
      const blank: FakePage = { text: "", elements: {} };
      this.pages.set(this.currentUrl, blank);
      return blank;
    }
    return page;
  }

  private require(selector: string): FakeElement {
    this.assertOpen();
    const element = this.page().elements[selector];
    if (!element) throw new Error(`No element matches ${selector}`);
    return element;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Browser session is closed");
  }

  private controller(): FakePageController {
    return {
      url: this.currentUrl,
      goto: (url) => this.navigate(url),
      get: (selector) => this.page().elements[selector],
      set: (selector, element) => {
        const elements = this.page().elements;
        if (element) elements[selector] = element;
        else delete elements[selector];
      },
      setText: (selector, text) => {
        const element = this.page().elements[selector];
        if (element) element.text = text;
      },
      setPageText: (text) => {
        this.page().text = text;
      },
    };
  }
}

export class FakeBrowserSessionProvider implements BrowserSessionProvider {
  readonly sessions: FakeBrowserSession[] = [];

  constructor(
    private readonly site: Record<string, FakePage> = {},
    private readonly capabilities: BrowserSessionCapabilities = {
      extensions: true,
      persistentProfile: true,
      liveScreen: false,
    },
  ) {}

  describe(): AdapterDescriptor<BrowserSessionCapabilities> {
    return descriptor("fake-browser", this.capabilities);
  }

  async open(persona: BrowserPersona, context: AdapterContext): Promise<FakeBrowserSession> {
    throwIfAborted(context);
    const parsed = BrowserPersonaSchema.parse(persona);
    if (parsed.extensionPaths?.length && !this.capabilities.extensions) {
      throw new Error("This browser provider cannot load extensions");
    }
    const session = new FakeBrowserSession(`fake-session-${this.sessions.length + 1}`, parsed, {
      ...this.site,
    });
    this.sessions.push(session);
    return session;
  }
}

export type FakeCaptchaCostKey = "ImageToText" | TokenCaptchaType;

export const FAKE_CAPTCHA_COSTS: Record<FakeCaptchaCostKey, number> = {
  ImageToText: 4,
  recaptcha_v2: 10,
  recaptcha_v3: 10,
  recaptcha_enterprise: 25,
  turnstile: 10,
  hcaptcha: 10,
  geetest: 9,
  funcaptcha: 15,
};

export type FakeCaptchaOutcome = string | CaptchaSolverError;

export interface FakeCaptchaSolverOptions {
  balance?: number;
  supports?: CaptchaType[];
  costs?: Partial<Record<FakeCaptchaCostKey, number>>;
  /** Scripted outcomes consumed in order; when exhausted every solve answers `fake-answer`. */
  outcomes?: FakeCaptchaOutcome[];
  /** Known knowledge questions, matched case-insensitively. */
  answers?: Record<string, string>;
}

export class FakeCaptchaSolver implements CaptchaSolver {
  readonly requests: CaptchaSolveRequest[] = [];
  readonly questions: CaptchaQuestionRequest[] = [];
  private credits: number;
  private readonly supports: CaptchaType[];
  private readonly costs: Record<FakeCaptchaCostKey, number>;
  private readonly outcomes: FakeCaptchaOutcome[];
  private readonly answers: Map<string, string>;
  private tasks = 0;

  constructor(options: FakeCaptchaSolverOptions = {}) {
    this.credits = options.balance ?? 1000;
    this.supports = options.supports ?? [
      "recaptcha_v2",
      "recaptcha_v3",
      "recaptcha_enterprise",
      "turnstile",
      "hcaptcha",
      "geetest",
      "funcaptcha",
      "image_letters",
      "knowledge_question",
    ];
    this.costs = { ...FAKE_CAPTCHA_COSTS, ...options.costs };
    this.outcomes = [...(options.outcomes ?? [])];
    this.answers = new Map(
      Object.entries(options.answers ?? {}).map(([question, answer]) => [
        normalizeQuestion(question),
        answer,
      ]),
    );
  }

  describe(): AdapterDescriptor<CaptchaSolverCapabilities> {
    return descriptor("fake-captcha", { supports: [...this.supports] });
  }

  async balance(context: AdapterContext): Promise<CaptchaBalance> {
    throwIfAborted(context);
    return { credits: this.credits };
  }

  async solve(request: CaptchaSolveRequest, context: AdapterContext): Promise<CaptchaSolveResult> {
    throwIfAborted(context);
    const parsed = parseCaptchaSolveRequest(request);
    const type: CaptchaType = parsed.type === "ImageToText" ? "image_letters" : parsed.type;
    if (!this.supports.includes(type)) throw new CaptchaSolverError("unsupported");
    const cost = this.costs[parsed.type];
    if (cost > this.credits) throw new CaptchaSolverError("credits");
    this.requests.push(parsed);
    const outcome = this.outcomes.shift() ?? "fake-answer";
    if (outcome instanceof CaptchaSolverError) throw outcome;
    this.credits -= cost;
    this.tasks += 1;
    return {
      answer: outcome,
      credits: cost,
      balance: this.credits,
      taskId: `fake-task-${this.tasks}`,
    };
  }

  async answerQuestion(
    request: CaptchaQuestionRequest,
    context: AdapterContext,
  ): Promise<CaptchaQuestionResult> {
    throwIfAborted(context);
    const parsed = CaptchaQuestionRequestSchema.parse(request);
    this.questions.push(parsed);
    const haystack = normalizeQuestion(parsed.question ?? parsed.pageText ?? "");
    for (const [question, answer] of this.answers) {
      if (haystack.includes(question)) return { answer };
    }
    return { couldNotAnswer: true };
  }
}

function normalizeQuestion(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

const FakeProxyInventorySchema = ProxyEndpointSchema.omit({ stickyKey: true, renewsAt: true });
export type FakeProxyInventory = z.input<typeof FakeProxyInventorySchema>;

/** Inventory of exit IPs per country and tier; a sticky key keeps its IP until released. */
export class FakeProxyProvider implements ProxyProvider {
  private readonly pool: z.infer<typeof FakeProxyInventorySchema>[];
  /** stickyKey → leased inventory id. */
  private readonly leases = new Map<string, string>();

  constructor(
    inventory: FakeProxyInventory[],
    private readonly options: { now?: () => Date; leaseHours?: number } = {},
  ) {
    this.pool = inventory.map((endpoint) => FakeProxyInventorySchema.parse(endpoint));
  }

  describe(): AdapterDescriptor<ProxyProviderCapabilities> {
    const coverage: Partial<Record<ProxyKind, CountryCode[]>> = {};
    for (const endpoint of this.pool) {
      const countries = coverage[endpoint.kind] ?? [];
      if (!countries.includes(endpoint.country)) countries.push(endpoint.country);
      coverage[endpoint.kind] = countries;
    }
    return descriptor("fake-proxy", { coverage, sticky: true });
  }

  async lease(request: ProxyLeaseRequest, context: AdapterContext): Promise<ProxyEndpoint> {
    throwIfAborted(context);
    const parsed = ProxyLeaseRequestSchema.parse(request);
    const existing = this.leases.get(parsed.stickyKey);
    if (existing) {
      const endpoint = this.inventory(existing);
      if (endpoint.country !== parsed.country) {
        throw new Error(`Sticky key ${parsed.stickyKey} is leased in ${endpoint.country}`);
      }
      return this.withLease(endpoint, parsed.stickyKey);
    }
    const leased = new Set(this.leases.values());
    for (const kind of parsed.kinds) {
      const endpoint = this.pool.find(
        (candidate) =>
          !leased.has(candidate.id) &&
          candidate.country === parsed.country &&
          candidate.kind === kind,
      );
      if (endpoint) {
        this.leases.set(parsed.stickyKey, endpoint.id);
        return this.withLease(endpoint, parsed.stickyKey);
      }
    }
    throw new Error(`No ${parsed.kinds.join(" or ")} proxy available in ${parsed.country}`);
  }

  async renew(id: string, context: AdapterContext): Promise<ProxyEndpoint> {
    throwIfAborted(context);
    const stickyKey = this.stickyKeyOf(id);
    if (!stickyKey) throw new Error(`Proxy ${id} is not leased`);
    return this.withLease(this.inventory(id), stickyKey);
  }

  async release(id: string, context: AdapterContext): Promise<void> {
    throwIfAborted(context);
    const stickyKey = this.stickyKeyOf(id);
    if (stickyKey) this.leases.delete(stickyKey);
  }

  private stickyKeyOf(id: string): string | undefined {
    for (const [stickyKey, endpointId] of this.leases) {
      if (endpointId === id) return stickyKey;
    }
    return undefined;
  }

  private inventory(id: string): z.infer<typeof FakeProxyInventorySchema> {
    const endpoint = this.pool.find((candidate) => candidate.id === id);
    if (!endpoint) throw new Error(`Unknown proxy ${id}`);
    return endpoint;
  }

  private withLease(
    endpoint: z.infer<typeof FakeProxyInventorySchema>,
    stickyKey: string,
  ): ProxyEndpoint {
    const now = this.options.now?.() ?? new Date(0);
    const hours = this.options.leaseHours ?? 24 * 30;
    return {
      ...endpoint,
      stickyKey,
      renewsAt: new Date(now.getTime() + hours * 3_600_000).toISOString(),
    };
  }
}

export class FakeSearchProvider implements SearchProvider {
  readonly requests: WebSearchRequest[] = [];

  constructor(
    private readonly results:
      | Record<string, WebSearchResult[]>
      | ((request: WebSearchRequest) => WebSearchResult[]) = {},
  ) {}

  describe(): AdapterDescriptor<SearchProviderCapabilities> {
    return descriptor("fake-search", { maxDepth: 100, operators: true });
  }

  async search(request: WebSearchRequest, context: AdapterContext): Promise<WebSearchResult[]> {
    throwIfAborted(context);
    const parsed = WebSearchRequestSchema.parse(request);
    this.requests.push(parsed);
    const all =
      typeof this.results === "function"
        ? this.results(parsed)
        : (this.results[parsed.query] ?? []);
    return all.slice(0, parsed.depth);
  }
}

export class FakeMailboxProvider implements MailboxProvider {
  private readonly inboxes = new Map<string, MailboxInbox>();
  private readonly mail: InboundMail[] = [];
  private readonly listeners = new Set<(mail: InboundMail) => void>();

  constructor(private readonly domain = "inbox.example.test") {}

  describe(): AdapterDescriptor<MailboxProviderCapabilities> {
    return descriptor("fake-mailbox", { inbound: "webhook" });
  }

  async ensureInbox(projectId: string, context: AdapterContext): Promise<MailboxInbox> {
    throwIfAborted(context);
    const existing = this.inboxes.get(projectId);
    if (existing) return existing;
    const index = this.inboxes.size + 1;
    const local = projectId.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "project";
    const inbox = { inboxId: `fake-inbox-${index}`, address: `${local}-${index}@${this.domain}` };
    this.inboxes.set(projectId, inbox);
    return inbox;
  }

  /** Simulates an inbound webhook delivery. */
  deliver(mail: InboundMail): void {
    const parsed = InboundMailSchema.parse(mail);
    if (![...this.inboxes.values()].some((inbox) => inbox.inboxId === parsed.inboxId)) {
      throw new Error(`Unknown inbox ${parsed.inboxId}`);
    }
    this.mail.push(parsed);
    for (const listener of this.listeners) listener(parsed);
  }

  onInbound(listener: (mail: InboundMail) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  messages(inboxId: string): InboundMail[] {
    return this.mail.filter((mail) => mail.inboxId === inboxId);
  }

  async listMessages(
    inboxId: string,
    options: { since?: Date },
    context: AdapterContext,
  ): Promise<InboundMail[]> {
    throwIfAborted(context);
    const since = options.since?.getTime();
    return this.messages(inboxId).filter(
      (mail) => since === undefined || Date.parse(mail.receivedAt) >= since,
    );
  }
}

export type FakeTextModelReply =
  | { json: unknown }
  | { text: string }
  | { refuse: string }
  | { error: string };

export type FakeTextModelScript =
  | Partial<Record<ModelLane, FakeTextModelReply[]>>
  | ((request: TextModelRequest<unknown>) => FakeTextModelReply);

export class FakeTextModel implements TextModel {
  readonly requests: Array<Omit<TextModelRequest<unknown>, "schema">> = [];
  private readonly queues: Partial<Record<ModelLane, FakeTextModelReply[]>>;

  constructor(
    private readonly script: FakeTextModelScript = {},
    private readonly modelIds: Partial<Record<ModelLane, string>> = {},
  ) {
    this.queues = {};
    if (typeof script !== "function") {
      for (const [lane, replies] of Object.entries(script)) {
        this.queues[lane as ModelLane] = [...(replies ?? [])];
      }
    }
  }

  describe(): AdapterDescriptor<TextModelCapabilities> {
    return descriptor("fake-text-model", {
      lanes: ["draft", "classify", "fallback"],
      structuredOutput: true,
    });
  }

  async complete<T>(
    request: TextModelRequest<T>,
    context: AdapterContext,
  ): Promise<TextModelResult<T>> {
    throwIfAborted(context);
    const { schema: _schema, ...logged } = request;
    this.requests.push(logged);
    const modelId = this.modelIds[request.lane] ?? `fake/${request.lane}`;
    const reply =
      typeof this.script === "function"
        ? this.script(request as TextModelRequest<unknown>)
        : this.queues[request.lane]?.shift();
    if (!reply) return { ok: false, reason: "error", modelId };
    if ("error" in reply) return { ok: false, reason: "error", raw: reply.error, modelId };
    if ("refuse" in reply) return { ok: false, reason: "refusal", raw: reply.refuse, modelId };
    let raw: string;
    let candidate: unknown;
    if ("text" in reply) {
      raw = reply.text;
      try {
        candidate = JSON.parse(reply.text);
      } catch {
        return { ok: false, reason: "schema", raw, modelId };
      }
    } else {
      raw = JSON.stringify(reply.json);
      candidate = reply.json;
    }
    const parsed = request.schema.safeParse(candidate);
    if (!parsed.success) return { ok: false, reason: "schema", raw, modelId };
    return {
      ok: true,
      value: parsed.data,
      modelId,
      tokens: {
        input: Math.ceil((request.system.length + request.user.length) / 4),
        output: Math.ceil(raw.length / 4),
      },
    };
  }
}
