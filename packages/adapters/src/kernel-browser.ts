import {
  type AdapterContext,
  type AdapterDescriptor,
  type BrowserPersona,
  BrowserPersonaSchema,
  type BrowserSession,
  type BrowserSessionCapabilities,
  type BrowserSessionFactory,
  type FormFieldInfo,
  type SecretRef,
} from "@rakazo/adapter-kit";
import { z } from "zod";

/**
 * Optional Kernel browser. HTTP only, through an injected fetch, and only constructed when a
 * secret ref is configured. The API key and proxy passwords stay SecretRefs until a call, then
 * travel as an https bearer or JSON body. They are not written into errors. No Kernel SDK.
 */

export const KERNEL_DEFAULT_BASE_URL = "https://api.onkernel.com";

const CreatedProxySchema = z.object({ id: z.string().min(1) }).passthrough();
const CreatedBrowserSchema = z
  .object({
    session_id: z.string().min(1),
    browser_live_view_url: z.string().optional(),
  })
  .passthrough();
const ExecuteSchema = z
  .object({
    success: z.boolean().optional(),
    result: z.unknown().optional(),
    error: z.string().optional(),
  })
  .passthrough();

export interface KernelBrowserConfig {
  apiKey: SecretRef;
  /** Must be https. Defaults to the public Kernel API origin. */
  baseUrl?: string;
  /** Names of extensions already stored in the Kernel project. Local paths are not uploaded. */
  extensionNames?: readonly string[];
  timeoutSeconds?: number;
}

export interface KernelBrowserDeps {
  loadSecret(ref: SecretRef, context: AdapterContext): Promise<string>;
  onSecret?(secret: string): void;
  fetch?: typeof fetch;
}

export class KernelBrowserSessionFactory implements BrowserSessionFactory {
  readonly mode = "kernel" as const;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly config: KernelBrowserConfig,
    private readonly deps: KernelBrowserDeps,
  ) {
    this.baseUrl = (config.baseUrl ?? KERNEL_DEFAULT_BASE_URL).replace(/\/$/, "");
    const url = new URL(this.baseUrl);
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error("Kernel base URL must be https");
    }
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
  }

  describe(): AdapterDescriptor<BrowserSessionCapabilities> {
    return {
      id: "kernel-browser",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        extensions: (this.config.extensionNames?.length ?? 0) > 0,
        persistentProfile: true,
        liveScreen: false,
      },
    };
  }

  async open(persona: BrowserPersona, context: AdapterContext): Promise<BrowserSession> {
    const parsed = BrowserPersonaSchema.parse(persona);
    const token = await this.deps.loadSecret(this.config.apiKey, context);
    this.deps.onSecret?.(token);
    const secrets = [token];
    const client = new KernelHttp(this.baseUrl, this.fetchImpl, token, secrets);
    const proxyId = await this.proxyId(parsed, context, client, secrets);
    const created = CreatedBrowserSchema.parse(
      await client.request("/browsers", {
        method: "POST",
        body: {
          headless: false,
          stealth: false,
          timeout_seconds: this.config.timeoutSeconds ?? 3_600,
          profile: { name: parsed.profileKey },
          ...(this.config.extensionNames?.length
            ? { extensions: this.config.extensionNames.map((name) => ({ name })) }
            : {}),
          ...(proxyId ? { proxy: { id: proxyId } } : {}),
        },
      }),
    );
    return new KernelBrowserSession(created.session_id, client);
  }

  private async proxyId(
    persona: BrowserPersona,
    context: AdapterContext,
    client: KernelHttp,
    secrets: string[],
  ): Promise<string | undefined> {
    if (!persona.proxy) return undefined;
    const username = persona.proxy.username
      ? await this.deps.loadSecret(persona.proxy.username, context)
      : undefined;
    const password = persona.proxy.password
      ? await this.deps.loadSecret(persona.proxy.password, context)
      : undefined;
    if (username) {
      secrets.push(username);
      this.deps.onSecret?.(username);
    }
    if (password) {
      secrets.push(password);
      this.deps.onSecret?.(password);
    }
    const [host, portText] = persona.proxy.server.split(":");
    const created = CreatedProxySchema.parse(
      await client.request("/proxies", {
        method: "POST",
        body: {
          type: "custom",
          name: `lb-${persona.profileKey}`.slice(0, 80),
          config: {
            host,
            port: Number(portText),
            ...(username ? { username } : {}),
            ...(password ? { password } : {}),
          },
        },
      }),
    );
    return created.id;
  }
}

class KernelHttp {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch,
    private readonly token: string,
    private readonly secrets: string[],
  ) {}

  redact(message: string): string {
    let text = message;
    for (const secret of this.secrets) {
      if (secret) text = text.split(secret).join("[redacted]");
    }
    return text.slice(0, 500);
  }

  async request(path: string, init: { method: string; body?: unknown }): Promise<unknown> {
    const url = new URL(path.replace(/^\//, ""), `${this.baseUrl}/`);
    if (url.protocol !== "https:" || url.origin !== new URL(this.baseUrl).origin) {
      throw new Error("Kernel requests must use https");
    }
    const response = await this.fetchImpl(url, {
      method: init.method,
      redirect: "manual",
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error("Kernel redirect refused");
    }
    if (response.status === 204) return null;
    const text = await response.text();
    if (!response.ok) throw new Error(this.redact(`Kernel request failed (${response.status})`));
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("Kernel returned a non-JSON body");
    }
  }
}

class KernelBrowserSession implements BrowserSession {
  private navigation: { status: number | null; headers: Record<string, string> } = {
    status: null,
    headers: {},
  };

  constructor(
    readonly id: string,
    private readonly http: KernelHttp,
  ) {}

  async goto(url: string): Promise<void> {
    const parsed = z.url({ protocol: /^https?$/ }).safeParse(url);
    if (!parsed.success) throw new Error("Kernel navigation requires an http(s) URL");
    const result = await this.playwright(
      `const response = await page.goto(args.url, { waitUntil: "domcontentloaded" });
       return { status: response ? response.status() : null, headers: response ? response.headers() : {} };`,
      { url },
      z.object({ status: z.number().int().nullable(), headers: z.record(z.string(), z.string()) }),
    );
    this.navigation = result;
  }

  async url(): Promise<string> {
    const result = await this.playwright(
      "return { url: page.url() };",
      {},
      z.object({ url: z.string() }),
    );
    return result.url;
  }

  async fill(selector: string, text: string): Promise<void> {
    await this.playwright(
      "await page.locator(args.selector).first().fill(args.text); return { ok: true };",
      { selector, text },
      z.object({ ok: z.literal(true) }),
    );
  }

  async click(selector: string): Promise<void> {
    await this.playwright(
      "await page.locator(args.selector).first().click(); return { ok: true };",
      { selector },
      z.object({ ok: z.literal(true) }),
    );
  }

  async text(selector: string): Promise<string | null> {
    const result = await this.playwright(
      `const loc = page.locator(args.selector);
       if (await loc.count() === 0) return { text: null };
       return { text: await loc.first().innerText() };`,
      { selector },
      z.object({ text: z.string().nullable() }),
    );
    return result.text;
  }

  async exists(selector: string): Promise<boolean> {
    const result = await this.playwright(
      "return { exists: (await page.locator(args.selector).count()) > 0 };",
      { selector },
      z.object({ exists: z.boolean() }),
    );
    return result.exists;
  }

  async attribute(selector: string, name: string): Promise<string | null> {
    const result = await this.playwright(
      `const loc = page.locator(args.selector);
       if (await loc.count() === 0) return { value: null };
       return { value: await loc.first().getAttribute(args.name) };`,
      { selector, name },
      z.object({ value: z.string().nullable() }),
    );
    return result.value;
  }

  async elementScreenshotPng(
    selector: string,
    options?: { paddingPx?: number; insetPx?: number },
  ): Promise<Uint8Array> {
    const result = await this.playwright(
      `const loc = page.locator(args.selector).first();
       const box = await loc.boundingBox();
       if (!box) throw new Error("element not found");
       const pad = args.paddingPx ?? 0;
       const inset = args.insetPx ?? 0;
       const x = Math.max(0, inset > 0 ? box.x + inset : box.x - pad);
       const y = Math.max(0, inset > 0 ? box.y + inset : box.y - pad);
       const width = inset > 0 ? Math.max(1, box.width - inset * 2) : box.width + pad * 2;
       const height = inset > 0 ? Math.max(1, box.height - inset * 2) : box.height + pad * 2;
       const bytes = await page.screenshot({ type: "png", clip: { x, y, width, height } });
       return { base64: Buffer.from(bytes).toString("base64") };`,
      { selector, paddingPx: options?.paddingPx ?? 0, insetPx: options?.insetPx ?? 0 },
      z.object({ base64: z.string() }),
    );
    return Buffer.from(result.base64, "base64");
  }

  async pageText(): Promise<string> {
    const result = await this.playwright(
      "return { text: await page.locator('body').innerText() };",
      {},
      z.object({ text: z.string() }),
    );
    return result.text;
  }

  async waitFor(selector: string, options: { timeoutMs: number }): Promise<boolean> {
    const result = await this.playwright(
      `try {
         await page.locator(args.selector).first().waitFor({ timeout: args.timeoutMs });
         return { found: true };
       } catch {
         return { found: false };
       }`,
      { selector, timeoutMs: options.timeoutMs },
      z.object({ found: z.boolean() }),
    );
    return result.found;
  }

  async screenshotPng(): Promise<Uint8Array> {
    const result = await this.playwright(
      `const bytes = await page.screenshot({ type: "png" });
       return { base64: Buffer.from(bytes).toString("base64") };`,
      {},
      z.object({ base64: z.string() }),
    );
    return Buffer.from(result.base64, "base64");
  }

  async injectToken(fieldName: string, token: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(fieldName)) throw new Error("Unexpected captcha field");
    await this.playwright(
      `await page.evaluate(({ name, value }) => {
         const root = globalThis;
         const doc = root.document;
         for (const field of doc.querySelectorAll('[name="' + name + '"]')) field.value = value;
         const callback = doc.querySelector("[data-callback]")?.getAttribute("data-callback");
         if (callback && /^[A-Za-z_$][\\w$]*$/.test(callback)) {
           const fn = root[callback];
           if (typeof fn === "function") fn(value);
         }
       }, { name: args.fieldName, value: args.token });
       return { ok: true };`,
      { fieldName, token },
      z.object({ ok: z.literal(true) }),
    );
  }

  async formFields(selector: string): Promise<FormFieldInfo[]> {
    const result = await this.playwright(
      `return await page.evaluate((rootSelector) => {
         const cssEscape = (value) => value.replace(/[^A-Za-z0-9_-]/g, "\\\\$&");
         const root = document.querySelector(rootSelector);
         if (!root) return { fields: [] };
         const form = root.matches("form") ? root : root.querySelector("form");
         const scope = form ?? root;
         const fields = [...scope.querySelectorAll("input, textarea, select, button")].map((el, index) => {
           const id = el.id || null;
           const name = el.getAttribute("name");
           const labelFor = id ? document.querySelector('label[for="' + CSS.escape(id) + '"]') : null;
           const wrapped = el.closest("label");
           const label = (labelFor?.textContent || wrapped?.textContent || "").trim();
           const selector = id ? "#" + cssEscape(id) : name ? '[name="' + cssEscape(name) + '"]' : rootSelector + " :nth-of-type(" + (index + 1) + ")";
           return {
             selector,
             tag: el.tagName.toLowerCase(),
             type: el.getAttribute("type"),
             name,
             id,
             autocomplete: el.getAttribute("autocomplete"),
             label,
             role: el.getAttribute("role"),
             required: el.hasAttribute("required"),
           };
         });
         return { fields };
       }, args.selector);`,
      { selector },
      z.object({
        fields: z.array(
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
          }),
        ),
      }),
    );
    return result.fields;
  }

  async navigationMeta(): Promise<{ status: number | null; headers: Record<string, string> }> {
    return this.navigation;
  }

  async close(): Promise<void> {
    await this.http.request(`/browsers/${encodeURIComponent(this.id)}`, { method: "DELETE" });
  }

  private async playwright<T>(body: string, args: unknown, schema: z.ZodType<T>): Promise<T> {
    const encoded = Buffer.from(JSON.stringify(args), "utf8").toString("base64");
    const code = `const args = JSON.parse(atob(${JSON.stringify(encoded)}));\n${body}`;
    let payload: unknown;
    try {
      payload = await this.http.request(
        `/browsers/${encodeURIComponent(this.id)}/playwright/execute`,
        {
          method: "POST",
          body: { code, timeout_sec: 60 },
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Kernel playwright execute failed";
      throw new Error(this.http.redact(message.split(encoded).join("[redacted]")));
    }
    const parsed = ExecuteSchema.safeParse(payload);
    if (!parsed.success || parsed.data.success === false) {
      throw new Error(
        this.http.redact(parsed.success ? (parsed.data.error ?? "failed") : "failed"),
      );
    }
    const value = schema.safeParse(parsed.data.result);
    if (!value.success) throw new Error("Kernel returned an unexpected result");
    return value.data;
  }
}
