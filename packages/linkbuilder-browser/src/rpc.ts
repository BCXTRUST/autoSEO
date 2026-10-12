import type { BrowserSession, ClickableControl, FormFieldInfo } from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/linkbuilder-core";
import { z } from "zod";

/*
 * JSON-RPC between the worker and the session runner that owns the browser inside the sandbox.
 * One request is one `BrowserSession` call; binary results travel as base64.
 */

const selector = z.string().min(1).max(2_000);

export const BrowserRpcRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("ping") }).strict(),
  z.object({ method: z.literal("goto"), url: z.url({ protocol: /^https?$/ }) }).strict(),
  z.object({ method: z.literal("url") }).strict(),
  z
    .object({
      method: z.literal("fill"),
      selector,
      text: z.string().max(20_000),
      secret: z.boolean().optional(),
    })
    .strict(),
  z.object({ method: z.literal("click"), selector }).strict(),
  z.object({ method: z.literal("text"), selector }).strict(),
  z.object({ method: z.literal("exists"), selector }).strict(),
  z.object({ method: z.literal("isVisible"), selector }).strict(),
  z.object({ method: z.literal("isChecked"), selector }).strict(),
  z.object({ method: z.literal("attribute"), selector, name: z.string().min(1).max(200) }).strict(),
  z
    .object({
      method: z.literal("elementScreenshotPng"),
      selector,
      paddingPx: z.number().int().min(0).max(200).optional(),
      insetPx: z.number().int().min(0).max(200).optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("injectToken"),
      fieldName: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
      token: z.string().min(1).max(8_000),
    })
    .strict(),
  z.object({ method: z.literal("pageText") }).strict(),
  z.object({ method: z.literal("ariaSnapshot") }).strict(),
  z.object({ method: z.literal("navigationMeta") }).strict(),
  z.object({ method: z.literal("formFields"), selector }).strict(),
  z.object({ method: z.literal("clickables") }).strict(),
  z.object({ method: z.literal("listText"), selector }).strict(),
  z.object({ method: z.literal("listAnchors"), selector }).strict(),
  z
    .object({
      method: z.literal("drag"),
      sourceSelector: selector,
      targetSelector: selector,
    })
    .strict(),
  z
    .object({
      method: z.literal("waitFor"),
      selector,
      timeoutMs: z.number().int().min(0).max(300_000),
    })
    .strict(),
  z.object({ method: z.literal("screenshotPng") }).strict(),
  z.object({ method: z.literal("clickConsent") }).strict(),
  z.object({ method: z.literal("loadedExtensions") }).strict(),
  z.object({ method: z.literal("extensionVersions") }).strict(),
  z.object({ method: z.literal("close") }).strict(),
]);
export type BrowserRpcRequest = z.infer<typeof BrowserRpcRequestSchema>;

const BinarySchema = z.object({ base64: z.string() }).strict();

export const BrowserRpcResponseSchema = z.union([
  z.object({ ok: z.literal(true), value: z.unknown().optional() }).strict(),
  z.object({ ok: z.literal(false), error: z.string() }).strict(),
]);
export type BrowserRpcResponse = z.infer<typeof BrowserRpcResponseSchema>;

export type BrowserRpcTransport = (request: BrowserRpcRequest) => Promise<BrowserRpcResponse>;

function binary(bytes: Uint8Array): { base64: string } {
  return { base64: Buffer.from(bytes).toString("base64") };
}

/** Dispatches validated requests to one session; errors never echo text filled as secret. */
export class BrowserRpcServer {
  private readonly secrets = new Set<string>();

  constructor(private readonly session: BrowserSession) {}

  async handle(raw: unknown): Promise<BrowserRpcResponse> {
    const parsed = BrowserRpcRequestSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "invalid request" };
    const request = parsed.data;
    if (request.method === "fill" && request.secret) this.secrets.add(request.text);
    try {
      return { ok: true, value: (await this.dispatch(request)) ?? null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: redactSecrets(message, this.secrets).slice(0, 2_000) };
    }
  }

  private async dispatch(request: BrowserRpcRequest): Promise<unknown> {
    const session = this.session;
    switch (request.method) {
      case "ping":
        return { sessionId: session.id };
      case "goto":
        return session.goto(request.url);
      case "url":
        return session.url();
      case "fill":
        return session.fill(request.selector, request.text, { secret: request.secret });
      case "click":
        return session.click(request.selector);
      case "text":
        return session.text(request.selector);
      case "exists":
        return session.exists(request.selector);
      case "isVisible":
        return session.isVisible
          ? session.isVisible(request.selector)
          : session.exists(request.selector);
      case "isChecked":
        return session.isChecked ? session.isChecked(request.selector) : false;
      case "attribute":
        return session.attribute(request.selector, request.name);
      case "elementScreenshotPng":
        return binary(
          await session.elementScreenshotPng(request.selector, {
            paddingPx: request.paddingPx,
            insetPx: request.insetPx,
          }),
        );
      case "injectToken":
        this.secrets.add(request.token);
        if (!session.injectToken) throw new Error("This browser cannot place a captcha token");
        return session.injectToken(request.fieldName, request.token);
      case "pageText":
        return session.pageText();
      case "ariaSnapshot":
        return session.ariaSnapshot ? session.ariaSnapshot() : "";
      case "navigationMeta":
        return session.navigationMeta ? session.navigationMeta() : { status: null, headers: {} };
      case "formFields":
        if (!session.formFields) throw new Error("This browser cannot list form fields");
        return session.formFields(request.selector);
      case "clickables":
        return session.clickables ? session.clickables() : [];
      case "listText":
        return session.listText ? session.listText(request.selector) : [];
      case "listAnchors":
        return session.listAnchors ? session.listAnchors(request.selector) : [];
      case "drag":
        if (!session.drag) return null;
        return session.drag(request.sourceSelector, request.targetSelector);
      case "waitFor":
        return session.waitFor(request.selector, { timeoutMs: request.timeoutMs });
      case "screenshotPng":
        return binary(await session.screenshotPng());
      case "clickConsent":
        return session.clickConsent ? session.clickConsent() : false;
      case "loadedExtensions":
        return session.loadedExtensions ? session.loadedExtensions() : [];
      case "extensionVersions":
        return session.extensionVersions ? session.extensionVersions() : [];
      case "close":
        return session.close();
    }
  }
}

export class BrowserRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserRpcError";
  }
}

/** `BrowserSession` over a transport; the worker never touches the browser process directly. */
export class RpcBrowserSession implements BrowserSession {
  constructor(
    readonly id: string,
    private readonly transport: BrowserRpcTransport,
    private readonly onClose?: () => Promise<void>,
  ) {}

  private async call(request: BrowserRpcRequest): Promise<unknown> {
    const response = BrowserRpcResponseSchema.parse(await this.transport(request));
    if (!response.ok) throw new BrowserRpcError(response.error);
    return response.value;
  }

  private async bytes(request: BrowserRpcRequest): Promise<Uint8Array> {
    const value = BinarySchema.parse(await this.call(request));
    return new Uint8Array(Buffer.from(value.base64, "base64"));
  }

  async goto(url: string): Promise<void> {
    await this.call({ method: "goto", url });
  }

  async url(): Promise<string> {
    return z.string().parse(await this.call({ method: "url" }));
  }

  async fill(selector: string, text: string, options: { secret?: boolean } = {}): Promise<void> {
    await this.call({ method: "fill", selector, text, secret: options.secret });
  }

  async click(selector: string): Promise<void> {
    await this.call({ method: "click", selector });
  }

  async text(selector: string): Promise<string | null> {
    return z
      .string()
      .nullable()
      .parse(await this.call({ method: "text", selector }));
  }

  async exists(selector: string): Promise<boolean> {
    return z.boolean().parse(await this.call({ method: "exists", selector }));
  }

  async isVisible(selector: string): Promise<boolean> {
    return z.boolean().parse(await this.call({ method: "isVisible", selector }));
  }

  async isChecked(selector: string): Promise<boolean> {
    return z.boolean().parse(await this.call({ method: "isChecked", selector }));
  }

  async attribute(selector: string, name: string): Promise<string | null> {
    return z
      .string()
      .nullable()
      .parse(await this.call({ method: "attribute", selector, name }));
  }

  elementScreenshotPng(
    selector: string,
    options?: { paddingPx?: number; insetPx?: number },
  ): Promise<Uint8Array> {
    return this.bytes({
      method: "elementScreenshotPng",
      selector,
      paddingPx: options?.paddingPx,
      insetPx: options?.insetPx,
    });
  }

  async injectToken(fieldName: string, token: string): Promise<void> {
    await this.call({ method: "injectToken", fieldName, token });
  }

  async pageText(): Promise<string> {
    return z.string().parse(await this.call({ method: "pageText" }));
  }

  async ariaSnapshot(): Promise<string> {
    return z.string().parse(await this.call({ method: "ariaSnapshot" }));
  }

  async navigationMeta(): Promise<{ status: number | null; headers: Record<string, string> }> {
    return z
      .object({ status: z.number().nullable(), headers: z.record(z.string(), z.string()) })
      .parse(await this.call({ method: "navigationMeta" }));
  }

  async listText(selector: string): Promise<string[]> {
    return z.array(z.string()).parse(await this.call({ method: "listText", selector }));
  }

  async listAnchors(selector: string): Promise<Array<{ text: string; href: string }>> {
    return z
      .array(z.object({ text: z.string(), href: z.string() }).strict())
      .parse(await this.call({ method: "listAnchors", selector }));
  }

  async drag(sourceSelector: string, targetSelector: string): Promise<void> {
    await this.call({ method: "drag", sourceSelector, targetSelector });
  }

  async clickables(): Promise<ClickableControl[]> {
    return z
      .array(
        z.object({
          selector: z.string(),
          tag: z.string(),
          role: z.string().nullable(),
          type: z.string().nullable(),
          text: z.string(),
          href: z.string().nullable(),
          inHeader: z.boolean(),
        }),
      )
      .parse(await this.call({ method: "clickables" }));
  }

  async formFields(selector: string): Promise<FormFieldInfo[]> {
    return z
      .array(
        z.object({
          selector: z.string(),
          tag: z.string(),
          type: z.string().nullable(),
          name: z.string().nullable(),
          id: z.string().nullable(),
          autocomplete: z.string().nullable(),
          label: z.string(),
          role: z.string().nullable(),
          required: z.boolean(),
          placeholder: z.string().nullable().optional(),
          group: z.string().nullable().optional(),
          hidden: z.boolean().optional(),
          value: z.string().nullable().optional(),
          options: z
            .array(z.object({ value: z.string(), label: z.string() }).strict())
            .optional(),
        }),
      )
      .parse(await this.call({ method: "formFields", selector }));
  }

  async waitFor(selector: string, options: { timeoutMs: number }): Promise<boolean> {
    return z
      .boolean()
      .parse(await this.call({ method: "waitFor", selector, timeoutMs: options.timeoutMs }));
  }

  screenshotPng(): Promise<Uint8Array> {
    return this.bytes({ method: "screenshotPng" });
  }

  async clickConsent(): Promise<boolean> {
    return z.boolean().parse(await this.call({ method: "clickConsent" }));
  }

  async loadedExtensions(): Promise<string[]> {
    return z.array(z.string()).parse(await this.call({ method: "loadedExtensions" }));
  }

  async extensionVersions(): Promise<Array<{ id: string; version: string }>> {
    return z
      .array(z.object({ id: z.string(), version: z.string() }))
      .parse(await this.call({ method: "extensionVersions" }));
  }

  async close(): Promise<void> {
    try {
      await this.call({ method: "close" });
    } finally {
      await this.onClose?.();
    }
  }
}
