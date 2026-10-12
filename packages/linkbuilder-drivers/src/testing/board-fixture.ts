import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { MarkupBoardConfig } from "../markup-driver.js";
import { type FixtureMail, type FixtureRel, renderBbcode } from "./phpbb-fixture.js";
import { noisePng } from "./png.js";

/**
 * Offline board for one platform. HTML comes from `fixtures/<platform>/`; users, posts and
 * mail stay in memory. Nothing is loaded from outside the loopback fixture.
 */

export interface MarkupFixtureOptions {
  boardName?: string;
  captchaAnswer?: string;
  rel?: FixtureRel;
  /** Shown as the new-member rule. Does not block the reply unless `enforceLinkRule` is set. */
  linkRuleMinPosts?: number;
  enforceLinkRule?: boolean;
  activation?: "email" | "none" | "admin";
  /**
   * Where an email activation link leaves the browser.
   * `message` is the stock notice, `login` is the login form, `session` logs the member in.
   */
  activationLanding?: "message" | "login" | "session";
  deliverMail(mail: FixtureMail): void | Promise<void>;
}

export interface FixtureProfile {
  bio: string;
  signature: string;
}

export interface MarkupFixture {
  origin: string;
  captchaAnswer: string;
  requests: Array<{
    method: string;
    path: string;
    cookie: string | null;
    userAgent: string | null;
  }>;
  users: Map<
    string,
    {
      id: number;
      username: string;
      email: string;
      password: string;
      active: boolean;
      postCount: number;
      activationKey: string;
    }
  >;
  registrationSubmits(): number;
  replySubmits(): number;
  profile(username: string): FixtureProfile | undefined;
  close(): Promise<void>;
}

export const FIXTURE_THREAD_TITLE = "Which software do you use for club membership lists?";

const TAKEN_USERNAME = "taken_user";

function templateCache(dir: URL): (name: string) => string {
  const cache = new Map<string, string>();
  return (name) => {
    let cached = cache.get(name);
    if (cached === undefined) {
      cached = readFileSync(new URL(`${name}.html.tmpl`, dir), "utf8");
      cache.set(name, cached);
    }
    return cached;
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function render(
  read: (name: string) => string,
  name: string,
  values: Record<string, string | number>,
): string {
  return read(name)
    .replace(/\{\{\{(\w+)\}\}\}/g, (_, key: string) => String(values[key] ?? ""))
    .replace(/\{\{(\w+)\}\}/g, (_, key: string) => escapeHtml(String(values[key] ?? "")));
}

function relAttribute(rel: FixtureRel): string {
  if (rel === "nofollow") return ' rel="nofollow"';
  if (rel === "ugc") return ' rel="ugc"';
  return ' rel="follow"';
}

function renderMarkdown(body: string, rel: FixtureRel): string {
  const parts: string[] = [];
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0;
  for (const match of body.matchAll(pattern)) {
    parts.push(escapeHtml(body.slice(last, match.index)));
    parts.push(
      `<a href="${escapeHtml(match[2]!)}"${relAttribute(rel)}>${escapeHtml(match[1]!)}</a>`,
    );
    last = match.index + match[0].length;
  }
  parts.push(escapeHtml(body.slice(last)));
  return parts.join("").replace(/\r?\n/g, "<br />");
}

function renderBody(
  body: string,
  format: MarkupBoardConfig["bodyFormat"],
  rel: FixtureRel,
): string {
  if (format === "markdown") return renderMarkdown(body, rel);
  if (format === "plain") {
    return escapeHtml(body).replace(/https?:\/\/[^\s<]+/g, (url) => {
      return `<a href="${escapeHtml(url)}"${relAttribute(rel)}>${escapeHtml(url)}</a>`;
    });
  }
  return renderBbcode(body, rel);
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 200_000) break;
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function cookies(request: IncomingMessage): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key) jar.set(key, rest.join("="));
  }
  return jar;
}

function samePath(url: URL, expected: string): boolean {
  const target = new URL(expected, "http://fixture.example");
  if (url.pathname !== target.pathname) return false;
  for (const [key, value] of target.searchParams) {
    if (url.searchParams.get(key) !== value) return false;
  }
  return true;
}

function routeOf(config: MarkupBoardConfig, url: URL): string {
  const routes = config.routes;
  const full = `${url.pathname}${url.search}`;
  if (url.pathname === routes.captcha) return "captcha";
  if (routes.json && url.pathname === routes.json) return "json";
  if (samePath(url, routes.activate)) return "activate";
  if (samePath(url, routes.register)) return "register";
  if (samePath(url, routes.login)) return "login";
  if (samePath(url, routes.profile)) return "profile";
  if (routes.reply.test(full)) return "reply";
  if (routes.permalink.test(full) || routes.thread.test(full)) return "thread";
  if (samePath(url, routes.list)) return "list";
  if (samePath(url, routes.index) || url.pathname === "/") return "index";
  return "missing";
}

function captchaBlock(config: MarkupBoardConfig): string {
  const key = "fixture-site-key";
  if (config.challenge === "recaptcha") {
    return `<div class="g-recaptcha" data-sitekey="${key}"><textarea name="g-recaptcha-response"></textarea></div>`;
  }
  if (config.challenge === "hcaptcha") {
    return `<div class="h-captcha" data-sitekey="${key}"><textarea name="h-captcha-response"></textarea></div>`;
  }
  if (config.challenge === "turnstile") {
    return `<div class="cf-turnstile" data-sitekey="${key}"><textarea name="cf-turnstile-response"></textarea></div>`;
  }
  if (config.challenge === "ips") {
    return `<div data-ipsCaptcha-key="${key}"><textarea name="cf-turnstile-response"></textarea></div>`;
  }
  if (config.challenge === "image") {
    const field = config.fields.captcha;
    return `<img class="captcha-image" src="${config.routes.captcha}" width="160" height="48" alt="Confirmation code" /><label for="${field.id}">Confirmation code</label><input id="${field.id}" name="${field.name}" autocomplete="off" />`;
  }
  return "";
}

export async function startMarkupFixture(
  config: MarkupBoardConfig,
  options: MarkupFixtureOptions,
): Promise<MarkupFixture> {
  const boardName = options.boardName ?? "Fixture board";
  const captchaAnswer = options.captchaAnswer ?? "K7XQ2";
  const rel = options.rel ?? "nofollow";
  const activation = options.activation ?? "email";
  const activationLanding = options.activationLanding ?? "message";
  const linkRuleMinPosts = options.linkRuleMinPosts ?? 3;
  const linkRule = `New members cannot post links until they have made ${linkRuleMinPosts} posts.`;
  const read = templateCache(new URL(`../../fixtures/${config.platform}/`, import.meta.url));
  const requests: MarkupFixture["requests"] = [];
  type User = MarkupFixture["users"] extends Map<string, infer V> ? V : never;
  const people = new Map<string, User>();
  const sessions = new Map<string, string>();
  const profiles = new Map<string, FixtureProfile>();
  const posts: Array<{ id: number; author: string; body: string }> = [
    {
      id: 1,
      author: "anna_k",
      body: "We are a small sports club and still keep members in a spreadsheet. What do you use for dues and member lists?",
    },
  ];
  let nextPostId = 2;
  let nextUserId = 2;
  let registrationSubmits = 0;
  let replySubmits = 0;
  let origin = "";
  const lastActivity = new Date(Date.now() - 86_400_000).toISOString();
  people.set(TAKEN_USERNAME, {
    id: 1,
    username: TAKEN_USERNAME,
    email: "taken@inbox.example",
    password: "unused-password",
    active: true,
    postCount: 4,
    activationKey: "taken",
  });

  const userFor = (request: IncomingMessage) => {
    const sid = cookies(request).get("fx_sid");
    const name = sid ? sessions.get(sid) : undefined;
    return name ? people.get(name) : undefined;
  };

  const page = (
    response: ServerResponse,
    request: IncomingMessage,
    title: string,
    content: string,
    status = 200,
    headers: Record<string, string> = {},
    forceUser?: User,
  ) => {
    const user = forceUser ?? userFor(request);
    const navUser = user
      ? `<a class="logout" href="${config.routes.index}">Logout [ ${escapeHtml(user.username)} ]</a>`
      : `<a href="${config.routes.login}">Login</a> <a href="${config.routes.register}">Register</a>`;
    response.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
    response.end(render(read, "layout", { title, boardName, content, navUser }));
  };

  const message = (
    response: ServerResponse,
    request: IncomingMessage,
    heading: string,
    text: string,
    link = "",
  ) => page(response, request, heading, render(read, "message", { heading, text, link }));

  const memberLink = `<article data-post-count="1"><a class="memberLink" href="https://tips.example/guide"${relAttribute(rel)}>a guide</a></article><p id="rules">${escapeHtml(linkRule)}</p>`;

  const fieldAttrs = {
    userId: config.fields.username.id,
    userName: config.fields.username.name,
    emailId: config.fields.email.id,
    emailName: config.fields.email.name,
    passwordId: config.fields.password.id,
    passwordName: config.fields.password.name,
    confirmId: config.fields.confirm.id,
    confirmName: config.fields.confirm.name,
    consentId: config.fields.consent.id,
    consentName: config.fields.consent.name,
    bodyId: config.fields.body.id,
    bodyName: config.fields.body.name,
    bioId: config.fields.bio.id,
    bioName: config.fields.bio.name,
    signatureId: config.fields.signature.id,
    signatureName: config.fields.signature.name,
    formClass: config.formClass,
    registerAction: config.routes.register,
    loginAction: config.routes.login,
    profileAction: config.routes.profile,
    replyAction: config.replyHref,
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", origin || "http://127.0.0.1");
    requests.push({
      method: request.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      cookie: request.headers.cookie ?? null,
      userAgent: request.headers["user-agent"] ?? null,
    });
    const route = routeOf(config, url);
    try {
      if (route === "captcha") {
        response.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
        return response.end(noisePng(160, 48, 9));
      }
      if (route === "json") {
        response.writeHead(200, { "content-type": "application/json" });
        return response.end(
          JSON.stringify({
            id: 1,
            slug: "membership",
            title: FIXTURE_THREAD_TITLE,
            post_stream: {
              posts: posts.map((post, index) => ({ id: post.id, post_number: index + 1 })),
            },
          }),
        );
      }
      if (route === "index" || route === "list") {
        const rows = `<li class="thread"><a class="threadTitle" href="${config.threadHref}">${escapeHtml(FIXTURE_THREAD_TITLE)}</a> <span class="replies">${Math.max(0, posts.length - 1)}</span> <time class="lastActivity" datetime="${lastActivity}">recent</time></li>`;
        return page(
          response,
          request,
          "Threads",
          render(read, "list", { rows, linkRule, ...fieldAttrs }),
        );
      }
      if (route === "thread") {
        const rendered = posts
          .map((post) => {
            const domId = config.postElementId?.(post.id) ?? `post${post.id}`;
            return `<article id="${domId}" class="post"><p class="author">${escapeHtml(post.author)}</p><div class="content">${renderBody(post.body, config.bodyFormat, rel)}</div></article>`;
          })
          .join("\n");
        return page(
          response,
          request,
          FIXTURE_THREAD_TITLE,
          render(read, "thread", {
            topicTitle: FIXTURE_THREAD_TITLE,
            posts: rendered,
            replyHref: config.replyHref,
            memberLink,
            linkRule,
            ...fieldAttrs,
          }),
        );
      }
      if (route === "register") {
        if (request.method !== "POST") {
          return page(
            response,
            request,
            "Register",
            render(read, "register", {
              captchaBlock: captchaBlock(config),
              linkRule,
              ...fieldAttrs,
            }),
          );
        }
        const form = await readForm(request);
        if (!form.has("submit")) {
          return page(
            response,
            request,
            "Register",
            render(read, "register", {
              captchaBlock: captchaBlock(config),
              linkRule,
              ...fieldAttrs,
            }),
          );
        }
        registrationSubmits += 1;
        const username = (form.get(config.fields.username.name) ?? "").trim();
        const email = (form.get(config.fields.email.name) ?? "").trim();
        const password = form.get(config.fields.password.name) ?? "";
        const retry = (error: string) =>
          page(
            response,
            request,
            "Register",
            render(read, "register", {
              username,
              email,
              error: `<p class="error">${escapeHtml(error)}</p>`,
              captchaBlock: captchaBlock(config),
              linkRule,
              ...fieldAttrs,
            }),
          );
        if (config.challenge === "image") {
          const given = (form.get(config.fields.captcha.name) ?? "").trim();
          if (given.toUpperCase() !== captchaAnswer.toUpperCase()) {
            return retry("The confirmation code you entered was incorrect.");
          }
        } else if (config.tokenField) {
          if (!form.get(config.tokenField)) return retry("You did not pass the security check.");
        }
        if (!form.get(config.fields.consent.name)) return retry("You must accept the board rules.");
        if (username.length < 3) return retry("The username you entered is too short.");
        if (people.has(username.toLowerCase()))
          return retry("The username you entered is already in use.");
        if (/banned/i.test(email)) return retry("This email address is banned.");
        if (!password) return retry("Entering a password is required.");
        if (password !== (form.get(config.fields.confirm.name) ?? "")) {
          return retry("The password confirmation does not match.");
        }
        const user: User = {
          id: nextUserId++,
          username,
          email,
          password,
          active: activation === "none",
          postCount: 0,
          activationKey: randomBytes(5).toString("hex"),
        };
        people.set(username.toLowerCase(), user);
        if (activation === "admin") {
          return message(
            response,
            request,
            "Information",
            "Your account has been created. An administrator will activate your account before you can log in.",
          );
        }
        if (activation === "none") {
          return message(
            response,
            request,
            "Information",
            "Thank you for registering, your account has been created. You may now login.",
          );
        }
        const link = `${origin}${config.routes.activate}${config.routes.activate.includes("?") ? "&" : "?"}u=${user.id}&k=${user.activationKey}`;
        await options.deliverMail({
          to: email,
          from: `noreply@${new URL(origin).hostname}`,
          subject: `Activate your account on ${boardName}`,
          textBody: `Hello ${username},\n\nVisit the activation link:\n\n${link}\n`,
          htmlBody: `<p><a href="${escapeHtml(link)}">Activate your account</a></p>`,
        });
        return message(
          response,
          request,
          "Information",
          "Your account has been created. An activation key has been sent to the email address you provided. Please check your email.",
        );
      }
      if (route === "activate") {
        const user = [...people.values()].find(
          (candidate) => candidate.id === Number(url.searchParams.get("u")),
        );
        if (!user || user.activationKey !== url.searchParams.get("k")) {
          return message(response, request, "Information", "The activation key does not match.");
        }
        user.active = true;
        const activated =
          "Your account has now been activated. You can now login with your username and password.";
        if (activationLanding === "session") {
          const sid = randomBytes(12).toString("hex");
          sessions.set(sid, user.username.toLowerCase());
          return page(
            response,
            request,
            "Information",
            render(read, "message", {
              heading: "Information",
              text: "Your account has now been activated. You are now logged in.",
              link: "",
            }),
            200,
            { "set-cookie": `fx_sid=${sid}; Path=/; HttpOnly; SameSite=Lax` },
            user,
          );
        }
        if (activationLanding === "login") {
          return page(
            response,
            request,
            "Login",
            `${render(read, "message", { heading: "Information", text: activated, link: "" })}${render(read, "login", { ...fieldAttrs })}`,
          );
        }
        return message(response, request, "Information", activated);
      }
      if (route === "login") {
        if (request.method !== "POST") {
          return page(response, request, "Login", render(read, "login", { ...fieldAttrs }));
        }
        const form = await readForm(request);
        const user = people.get((form.get(config.fields.username.name) ?? "").trim().toLowerCase());
        if (!user || user.password !== form.get(config.fields.password.name) || !user.active) {
          const error =
            user && !user.active
              ? "Your account has not been activated."
              : "Incorrect username or password.";
          return page(
            response,
            request,
            "Login",
            render(read, "login", {
              error: `<p class="error">${escapeHtml(error)}</p>`,
              ...fieldAttrs,
            }),
          );
        }
        const sid = randomBytes(12).toString("hex");
        sessions.set(sid, user.username.toLowerCase());
        response.writeHead(302, {
          location: config.routes.list,
          "set-cookie": `fx_sid=${sid}; Path=/; HttpOnly; SameSite=Lax`,
        });
        return response.end();
      }
      if (route === "profile") {
        const user = userFor(request);
        if (!user) return message(response, request, "Login", "You need to login.");
        const saved = profiles.get(user.username.toLowerCase()) ?? { bio: "", signature: "" };
        if (request.method !== "POST") {
          return page(
            response,
            request,
            "Profile",
            render(read, "profile", { bio: saved.bio, signature: saved.signature, ...fieldAttrs }),
          );
        }
        const form = await readForm(request);
        const next = {
          bio: form.get(config.fields.bio.name) ?? "",
          signature: form.get(config.fields.signature.name) ?? "",
        };
        profiles.set(user.username.toLowerCase(), next);
        return message(response, request, "Profile", "Your profile has been saved.");
      }
      if (route === "reply") {
        const user = userFor(request);
        if (!user)
          return message(response, request, "Login", "You need to login in order to reply.");
        const form = request.method === "POST" ? await readForm(request) : null;
        const body = form?.get(config.fields.body.name)?.trim() ?? "";
        const formPage = (error: string) =>
          page(
            response,
            request,
            "Reply",
            render(read, "reply", {
              topicTitle: FIXTURE_THREAD_TITLE,
              message: body,
              error: error ? `<p class="error">${escapeHtml(error)}</p>` : "",
              memberLink,
              linkRule,
              ...fieldAttrs,
            }),
          );
        if (!form?.has("submit")) return formPage("");
        replySubmits += 1;
        if (body.length < 10) return formPage("The message you entered is too short.");
        if (
          options.enforceLinkRule &&
          user.postCount < linkRuleMinPosts &&
          /\[url|\]\(https?:|https?:\/\//i.test(body)
        ) {
          return formPage(
            `You are not allowed to post links until you have made ${linkRuleMinPosts} posts.`,
          );
        }
        const post = { id: nextPostId++, author: user.username, body };
        posts.push(post);
        user.postCount += 1;
        const permalink = config.permalinkHref(post.id, posts.length);
        return message(
          response,
          request,
          "Information",
          "This message has been posted successfully.",
          `<p><a class="permalink" href="${escapeHtml(permalink)}">View your submitted message</a></p>`,
        );
      }
      return message(response, request, "Missing", "The page you requested does not exist.");
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : "fixture error");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    captchaAnswer,
    requests,
    users: people,
    registrationSubmits: () => registrationSubmits,
    replySubmits: () => replySubmits,
    profile: (username) => profiles.get(username.toLowerCase()),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
