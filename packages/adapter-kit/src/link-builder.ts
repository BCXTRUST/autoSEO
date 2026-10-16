import {
  LbCaptchaTypeSchema,
  LbCountryCodeSchema,
  LbLanguageSchema,
  LbLocaleSchema,
  LbModelLaneSchema,
  LbProxyKindSchema,
  LbTokenCaptchaTypeSchema,
} from "@rakazo/contracts";
import { z } from "zod";
import type { AdapterContext, AdapterDescriptor } from "./types.js";

/** Reference to a value in the encrypted secret store. Contracts never carry plaintext. */
export const SecretRefSchema = z.object({ secretId: z.string().min(1) }).strict();
export type SecretRef = z.infer<typeof SecretRefSchema>;

export const CountryCodeSchema = LbCountryCodeSchema;
export type CountryCode = z.infer<typeof CountryCodeSchema>;

export const ProxyKindSchema = LbProxyKindSchema;
export type ProxyKind = z.infer<typeof ProxyKindSchema>;

/** Persona × country; the same key must yield the same exit IP for the life of the account. */
export const ProxyStickyKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);

export const ProxyEndpointSchema = z
  .object({
    id: z.string().min(1),
    country: CountryCodeSchema,
    stickyKey: ProxyStickyKeySchema,
    /** `host:port`; the address is not a credential, the username and password are. */
    server: z.string().regex(/^[^\s:/@]+:\d{1,5}$/, "Expected host:port"),
    /** How the browser should dial `server`. Absent means HTTP. */
    protocol: z.enum(["http", "socks5"]).optional(),
    username: SecretRefSchema.optional(),
    password: SecretRefSchema.optional(),
    kind: ProxyKindSchema,
    renewsAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type ProxyEndpoint = z.infer<typeof ProxyEndpointSchema>;

export const ProxyLeaseRequestSchema = z
  .object({
    /** The forum host's country, never a regional pool. */
    country: CountryCodeSchema,
    stickyKey: ProxyStickyKeySchema,
    /** Tiers in order of preference; the first one with inventory in `country` wins. */
    kinds: z.array(ProxyKindSchema).min(1).default(["static_isp", "residential"]),
  })
  .strict();
export type ProxyLeaseRequest = z.input<typeof ProxyLeaseRequestSchema>;

export interface ProxyProviderCapabilities {
  /** Countries with inventory per tier; `"*"` means any ISO country. */
  coverage: Partial<Record<ProxyKind, CountryCode[] | "*">>;
  /** Re-leasing with the same sticky key returns the same exit IP. */
  sticky: boolean;
}

export interface ProxyProvider {
  describe(): AdapterDescriptor<ProxyProviderCapabilities>;
  lease(request: ProxyLeaseRequest, context: AdapterContext): Promise<ProxyEndpoint>;
  renew(id: string, context: AdapterContext): Promise<ProxyEndpoint>;
  release(id: string, context: AdapterContext): Promise<void>;
}

export const BrowserPersonaSchema = z.object({
  projectId: z.string().min(1),
  /** Stable key of the persistent profile directory for this persona. */
  profileKey: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  proxy: ProxyEndpointSchema.optional(),
  locale: LbLocaleSchema,
  timezoneId: z.string().min(1),
  /** Sent as the `Accept-Language` header. Derived from `locale` when omitted. */
  acceptLanguage: z.string().min(1).max(200).optional(),
  /** `camoufox` is the Firefox fallback. Absent means the Chromium engine. */
  engine: z.enum(["chromium", "camoufox"]).optional(),
  extensionPaths: z.array(z.string().min(1)).optional(),
});
export type BrowserPersona = z.infer<typeof BrowserPersonaSchema>;

export interface BrowserSessionCapabilities {
  extensions: boolean;
  persistentProfile: boolean;
  liveScreen: boolean;
}

/**
 * The page operations board drivers need. Selectors are CSS selectors resolved against the
 * current page; implementations must not log, trace or return text filled with `secret: true`.
 */
export interface BrowserSession {
  readonly id: string;
  goto(url: string): Promise<void>;
  url(): Promise<string>;
  fill(selector: string, text: string, options?: { secret?: boolean }): Promise<void>;
  /**
   * The signup form is the current step. Fill must not scroll a field into view, and
   * navigation waits until that step is submitted.
   */
  holdForm?(): Promise<void>;
  /** The current signup step was submitted. Scrolling and navigation work again. */
  releaseForm?(): Promise<void>;
  click(selector: string): Promise<void>;
  /** Visible text of the first match, or null when nothing matches. */
  text(selector: string): Promise<string | null>;
  exists(selector: string): Promise<boolean>;
  /** True when the first match is shown. Hidden consent controls are not a wall. */
  isVisible?(selector: string): Promise<boolean>;
  /** True when a checkbox or radio is selected. */
  isChecked?(selector: string): Promise<boolean>;
  attribute(selector: string, name: string): Promise<string | null>;
  /**
   * Tight PNG of the first match, used for image captchas instead of a full screenshot.
   * `paddingPx` expands the crop when the tight image is too small. `insetPx` pulls the crop
   * in from the element edge when the solver cannot read the picture.
   */
  elementScreenshotPng(selector: string, options?: ElementScreenshotOptions): Promise<Uint8Array>;
  pageText(): Promise<string>;
  /** Page HTML, used when a captcha site key is not on a widget attribute. */
  pageHtml?(): Promise<string>;
  /** Accessibility tree for one look. Browser agents choose the next control from this. */
  ariaSnapshot?(): Promise<string>;
  /** Resolves true once the selector matches, false when the timeout elapses first. */
  waitFor(selector: string, options: { timeoutMs: number }): Promise<boolean>;
  screenshotPng(): Promise<Uint8Array>;
  /**
   * Screenshot the page, then click a visible accept control, including one inside a frame
   * that page text does not include. Returns false when no accept control is visible.
   */
  clickConsent?(): Promise<boolean>;
  /** Ids of the extensions the browser loaded, read from their service workers. */
  loadedExtensions?(): Promise<string[]>;
  /** Id and manifest version of each loaded extension, when the browser can read them. */
  extensionVersions?(): Promise<Array<{ id: string; version: string }>>;
  /**
   * Writes a captcha token into the named response field and invokes a page `data-callback`
   * when one exists. Implementations must not include the token in errors or action logs.
   */
  injectToken?(fieldName: string, token: string): Promise<void>;
  /**
   * Controls inside the first matching form, with labels and autocomplete, for the generic
   * driver. Mapping uses this DOM description only; it never screenshots the page.
   */
  formFields?(selector: string): Promise<FormFieldInfo[]>;
  /**
   * Visible links and buttons, read once, so a driver can click Register before it looks
   * at a form. Hidden controls are omitted.
   */
  clickables?(): Promise<ClickableControl[]>;
  /** Visible text of every match, in order. One read. */
  listText?(selector: string): Promise<string[]>;
  /** Text and href of every matching anchor, in order. One read. */
  listAnchors?(selector: string): Promise<Array<{ text: string; href: string }>>;
  /** Moves a control onto another, for a sortable confirmation the page asks the reader to drag. */
  drag?(sourceSelector: string, targetSelector: string): Promise<void>;
  /** Status and headers of the last document response, when the engine recorded one. */
  navigationMeta?(): Promise<{ status: number | null; headers: Record<string, string> }>;
  close(): Promise<void>;
}

/** A visible link, button, or menu item. `selector` addresses that control. */
export interface ClickableControl {
  selector: string;
  tag: string;
  role: string | null;
  /** Submit, button, or empty when the control is a link. */
  type: string | null;
  text: string;
  href: string | null;
  /** True when the control sits in a header, nav, or menu bar. */
  inHeader: boolean;
}

/** One control inside a form, as read from the DOM. `selector` addresses that control. */
export interface FormFieldInfo {
  selector: string;
  tag: string;
  type: string | null;
  name: string | null;
  id: string | null;
  autocomplete: string | null;
  label: string;
  role: string | null;
  required: boolean;
  placeholder?: string | null;
  /** Fieldset legend, when the control sits in one. */
  group?: string | null;
  /** True for hidden and `display:none` controls. Those stay empty. */
  hidden?: boolean;
  /** Current value, including a radio or checkbox value. */
  value?: string | null;
  /** Select options, in document order. */
  options?: readonly { value: string; label: string }[];
}

export interface BrowserSessionProvider {
  describe(): AdapterDescriptor<BrowserSessionCapabilities>;
  open(persona: BrowserPersona, context: AdapterContext): Promise<BrowserSession>;
}

/**
 * Where the persona browser runs. `sandbox` drives it inside the computer sandbox; `local` runs it
 * in-process on the worker host and is only for tests and sandbox-less development.
 */
export type BrowserSessionMode = "local" | "sandbox" | "kernel";

export interface BrowserSessionFactory extends BrowserSessionProvider {
  readonly mode: BrowserSessionMode;
}

export const CaptchaTypeSchema = LbCaptchaTypeSchema;
export type CaptchaType = z.infer<typeof CaptchaTypeSchema>;
export const TokenCaptchaTypeSchema = LbTokenCaptchaTypeSchema;
export type TokenCaptchaType = z.infer<typeof TokenCaptchaTypeSchema>;

/** The primary solver refuses images below this size, so the contract rejects them up front. */
export const MIN_CAPTCHA_IMAGE_BYTES = 100;

export const ImageToTextRequestSchema = z.object({
  type: z.literal("ImageToText"),
  imagePng: z
    .custom<Uint8Array>((value) => value instanceof Uint8Array, "Expected PNG bytes")
    .refine((bytes) => bytes.byteLength >= MIN_CAPTCHA_IMAGE_BYTES, {
      message: `Captcha image must be at least ${MIN_CAPTCHA_IMAGE_BYTES} bytes; re-crop with padding`,
    }),
});
export type ImageToTextRequest = z.infer<typeof ImageToTextRequestSchema>;

/** Captell accepts a boolean and the strings the parser treats as true. */
export const CaptchaFlagSchema = z.union([
  z.boolean(),
  z.literal("true"),
  z.literal("false"),
  z.literal("1"),
  z.literal("0"),
]);

export interface ElementScreenshotOptions {
  paddingPx?: number;
  insetPx?: number;
}

export const TokenRequestSchema = z.object({
  type: TokenCaptchaTypeSchema,
  websiteURL: z.url({ protocol: /^https?$/ }),
  websiteKey: z.string().min(1),
  /** Invisible v2 is RecaptchaV2 with this flag, not a separate type. */
  isInvisible: CaptchaFlagSchema.optional(),
  isEnterprise: CaptchaFlagSchema.optional(),
  pageAction: z.string().min(1).max(200).optional(),
  minScore: z.number().min(0).max(1).optional(),
  action: z.string().min(1).max(200).optional(),
  cData: z.string().min(1).max(2_000).optional(),
  chlPageData: z.string().min(1).max(8_000).optional(),
  enterprisePayload: z.union([z.string().min(1), z.record(z.string(), z.unknown())]).optional(),
  challenge: z.string().min(1).max(8_000).optional(),
});
export type TokenRequest = z.infer<typeof TokenRequestSchema>;

export const CaptchaSolveRequestSchema = z.union([ImageToTextRequestSchema, TokenRequestSchema]);
export type CaptchaSolveRequest = ImageToTextRequest | TokenRequest;

export const CaptchaSolveResultSchema = z.object({
  answer: z.string().min(1),
  credits: z.number().int().min(0),
  balance: z.number().int(),
  taskId: z.string().min(1),
});
export type CaptchaSolveResult = z.infer<typeof CaptchaSolveResultSchema>;

export const CaptchaQuestionRequestSchema = z
  .object({ question: z.string().min(1).optional(), pageText: z.string().min(1).optional() })
  .refine((request) => request.question !== undefined || request.pageText !== undefined, {
    message: "Provide question or pageText",
  });
export type CaptchaQuestionRequest = z.infer<typeof CaptchaQuestionRequestSchema>;

export const CaptchaQuestionResultSchema = z.union([
  z.object({ answer: z.string().min(1) }).strict(),
  z.object({ instruction: z.string().min(1) }).strict(),
  z.object({ couldNotAnswer: z.literal(true) }).strict(),
]);
export type CaptchaQuestionResult =
  | { answer: string }
  | { instruction: string }
  | { couldNotAnswer: true };

export const CaptchaBalanceSchema = z.object({ credits: z.number().int() });
export type CaptchaBalance = z.infer<typeof CaptchaBalanceSchema>;

export type CaptchaSolverErrorCode =
  | "invalid_request"
  | "not_read"
  | "no_token"
  | "missing_site_key"
  | "unsupported"
  | "credits"
  | "refused"
  | "sandbox"
  | "error";

/** Typed solver failure; `retryable` means another attempt on the same captcha may succeed. */
export class CaptchaSolverError extends Error {
  readonly code: CaptchaSolverErrorCode;
  readonly retryable: boolean;

  constructor(code: CaptchaSolverErrorCode, message?: string, options?: { retryable?: boolean }) {
    super(message ?? code);
    this.name = "CaptchaSolverError";
    this.code = code;
    this.retryable =
      options?.retryable ?? (code === "not_read" || code === "no_token" || code === "error");
  }
}

export interface CaptchaSolverCapabilities {
  supports: CaptchaType[];
}

export interface CaptchaSolver {
  describe(): AdapterDescriptor<CaptchaSolverCapabilities>;
  balance(context: AdapterContext): Promise<CaptchaBalance>;
  solve(request: CaptchaSolveRequest, context: AdapterContext): Promise<CaptchaSolveResult>;
  answerQuestion(
    request: CaptchaQuestionRequest,
    context: AdapterContext,
  ): Promise<CaptchaQuestionResult>;
}

const SECRET_REGISTRATION_PROMPT =
  /password|passwort|kennwort|2fa|two[- ]factor|authenticator|\botp\b|one[- ]time|e-?mail code|verification code|bestätigungscode|confirmation code/i;

/** Passwords, 2FA and email codes are never sent to a solver. */
export function isSecretRegistrationPrompt(text: string): boolean {
  return SECRET_REGISTRATION_PROMPT.test(text);
}

/** Validates a solve request before any adapter spends credits on it. */
export function parseCaptchaSolveRequest(request: unknown): CaptchaSolveRequest {
  const parsed = CaptchaSolveRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw new CaptchaSolverError("invalid_request", parsed.error.issues[0]?.message);
  }
  return parsed.data;
}

export const WebSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(2000),
  country: CountryCodeSchema,
  language: LbLanguageSchema,
  /** Number of results requested; adapters may return fewer. */
  depth: z.number().int().min(1).max(100).default(10),
});
export type WebSearchRequest = z.input<typeof WebSearchRequestSchema>;

export const WebSearchResultSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  title: z.string(),
  snippet: z.string(),
  domain: z.string().min(1),
  publishedAt: z.string().datetime({ offset: true }).optional(),
});
export type WebSearchResult = z.infer<typeof WebSearchResultSchema>;

export interface SearchProviderCapabilities {
  maxDepth: number;
  /** Supports `inurl:` style footprint operators. */
  operators: boolean;
}

export interface SearchProvider {
  describe(): AdapterDescriptor<SearchProviderCapabilities>;
  search(request: WebSearchRequest, context: AdapterContext): Promise<WebSearchResult[]>;
}

export const MailboxInboxSchema = z.object({
  inboxId: z.string().min(1),
  address: z.email(),
});
export type MailboxInbox = z.infer<typeof MailboxInboxSchema>;

export const InboundMailSchema = z.object({
  inboxId: z.string().min(1),
  from: z.string().min(1),
  subject: z.string(),
  textBody: z.string(),
  htmlBody: z.string().optional(),
  receivedAt: z.string().datetime({ offset: true }),
});
export type InboundMail = z.infer<typeof InboundMailSchema>;

export interface MailboxProviderCapabilities {
  inbound: "webhook" | "poll";
}

export interface MailboxProvider {
  describe(): AdapterDescriptor<MailboxProviderCapabilities>;
  /** Idempotent: returns the existing inbox for a project when one exists. */
  ensureInbox(projectId: string, context: AdapterContext): Promise<MailboxInbox>;
  /** Mail received by an inbox, oldest first; `since` excludes earlier mail. */
  listMessages?(
    inboxId: string,
    options: { since?: Date },
    context: AdapterContext,
  ): Promise<InboundMail[]>;
}

export const ModelLaneSchema = LbModelLaneSchema;
export type ModelLane = z.infer<typeof ModelLaneSchema>;

export interface TextModelRequest<T> {
  lane: ModelLane;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxTokens: number;
  /** Overrides the lane model for one call. Callers must pass a fixed model id. */
  modelId?: string;
}

export interface TextModelTokens {
  input: number;
  output: number;
}

export type TextModelFailureReason = "refusal" | "schema" | "error";

export type TextModelResult<T> =
  | { ok: true; value: T; modelId: string; tokens: TextModelTokens }
  | { ok: false; reason: TextModelFailureReason; raw?: string; modelId: string };

export interface TextModelCapabilities {
  lanes: ModelLane[];
  structuredOutput: boolean;
}

export interface TextModel {
  describe(): AdapterDescriptor<TextModelCapabilities>;
  complete<T>(request: TextModelRequest<T>, context: AdapterContext): Promise<TextModelResult<T>>;
}

export const LINK_BUILDER_CONTRACT_VERSION = "1";
