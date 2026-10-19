import type { BrowserPersona } from "@rakazo/adapter-kit";
import { FakeBrowserSession } from "@rakazo/adapter-kit";
import { hostState, planRealStep } from "@rakazo/linkbuilder-core";
import { describe, expect, it } from "vitest";
import { REAL_STEP_HANDLERS, type StepContext } from "./link-builder-real-steps.js";

describe("email verification", () => {
  it("keeps running after a successful verify so warmup can post", async () => {
    const link = "https://forum.example/ucp.php?mode=activate&u=1&k=abc";
    const persona = {
      projectId: "p1",
      profileKey: "p1",
      locale: "de-DE",
      timezoneId: "Europe/Berlin",
    } as BrowserPersona;
    const session = new FakeBrowserSession("session-1", persona, {
      [link]: {
        text: "",
        elements: { "div#message": { text: "Your account has been activated" } },
      },
    });
    const updates: string[] = [];
    const tx = {
      lbHostAccount: {
        update: async () => {
          updates.push("account");
          return {};
        },
      },
      lbHost: {
        updateMany: async () => {
          updates.push("host");
          return { count: 1 };
        },
      },
      lbProject: {
        updateMany: async (args: { data: { status: string } }) => {
          updates.push(args.data.status);
          return { count: 1 };
        },
      },
    };
    const ctx = {
      now: new Date("2026-10-16T12:00:00.000Z"),
      run: {
        id: "run-1",
        status: "running",
        counters: { newToday: 0, liveToday: 0, liveWeek: 0, uniqueHosts: 0 },
      },
      project: {
        id: "p1",
        workspaceId: "w1",
        mailboxId: "lena.hoffmann@sideinbox.email",
        mailboxAddress: "lena.hoffmann@sideinbox.email",
      },
      host: {
        id: "h1",
        status: "pending_email",
        platform: "phpbb",
        homepageUrl: "https://forum.example/",
        registrableDomain: "forum.example",
        parkedFrom: null,
      },
      account: { id: "acct-1", createdAt: new Date("2026-10-16T11:00:00.000Z") },
      adapter: {
        operationId: "t",
        traceId: "t",
        workspaceId: "w1",
        userId: "u",
        signal: new AbortController().signal,
      },
      secrets: [],
      pool: () => ({
        session,
        hostId: "h1",
        helperConnected: true,
        cookieChecked: true,
        registerFormReady: false,
        captchaAttempts: 0,
        registrationRetried: false,
        spamRetries: 0,
        profileSet: false,
        engine: "chromium",
        marketKey: "DE:de",
        helperVersion: null,
      }),
      storeArtifact: async () => "art-1",
      services: {
        prisma: {
          lbHostAccount: { count: async () => 0 },
        },
        mailbox: {
          listMessages: async () => [
            {
              subject: "Activate",
              textBody: link,
              htmlBody: `<a href="${link}">open</a>`,
            },
          ],
        },
      },
    } as unknown as StepContext;

    const result = await REAL_STEP_HANDLERS.email_verify(ctx);
    expect(result.kind).toBe("step");
    if (result.kind !== "step") return;
    expect(result.lastAction).toBe("Email verified");
    expect(result.run?.status).toBeUndefined();
    await result.apply?.(tx as never);
    expect(updates).not.toContain("paused");
    expect(updates).toContain("account");
    expect(session.actions.some((action) => action.kind === "goto" && action.url === link)).toBe(
      true,
    );

    const plan = planRealStep({
      runStatus: "running",
      liveMet: false,
      host: { id: "h1", ...hostState("warming") },
      session: {
        hostId: "h1",
        helperConnected: true,
        cookieChecked: true,
        registerFormReady: false,
      },
      warmupMet: false,
      warmupPostsShort: true,
      minPostsBeforeLink: 0,
      warmupPosts: 0,
      placement: null,
    });
    expect(plan).toEqual({ kind: "warmup_post" });
  });

  it("polls until the confirmation link arrives and keeps one login", async () => {
    const link = "https://forum.example/ucp.php?mode=activate&u=1&k=abc";
    const persona = {
      projectId: "p1",
      profileKey: "p1",
      locale: "de-DE",
      timezoneId: "Europe/Berlin",
    } as BrowserPersona;
    const session = new FakeBrowserSession("session-1", persona, {
      [link]: {
        text: "",
        elements: { "div#message": { text: "Your account has been activated" } },
      },
    });
    let polls = 0;
    const logins: string[] = [];
    const ctx = {
      now: new Date("2026-10-16T12:00:00.000Z"),
      run: {
        id: "run-1",
        status: "running",
        counters: { newToday: 0, liveToday: 0, liveWeek: 0, uniqueHosts: 0 },
      },
      project: {
        id: "p1",
        workspaceId: "w1",
        mailboxId: "lena.hoffmann@sideinbox.email",
        mailboxAddress: "lena.hoffmann@sideinbox.email",
      },
      host: {
        id: "h1",
        status: "pending_email",
        platform: "phpbb",
        homepageUrl: "https://forum.example/",
        registrableDomain: "forum.example",
        parkedFrom: null,
      },
      account: { id: "acct-1", createdAt: new Date("2026-10-16T11:00:00.000Z") },
      adapter: {
        operationId: "t",
        traceId: "t",
        workspaceId: "w1",
        userId: "u",
        signal: new AbortController().signal,
      },
      secrets: [],
      pool: () => ({
        session,
        hostId: "h1",
        helperConnected: true,
        cookieChecked: true,
        registerFormReady: false,
        captchaAttempts: 0,
        registrationRetried: false,
        spamRetries: 0,
        profileSet: false,
        engine: "chromium",
        marketKey: "DE:de",
        helperVersion: null,
        driver: {
          activationResult: async () => "active",
        },
      }),
      storeArtifact: async () => "art-1",
      services: {
        sleep: async () => undefined,
        prisma: {
          lbHostAccount: {
            count: async () => 0,
            create: async () => {
              logins.push("create");
              return {};
            },
          },
          siteLogin: {
            create: async () => {
              logins.push("login");
              return {};
            },
          },
        },
        mailbox: {
          listMessages: async () => {
            polls += 1;
            if (polls < 2) return [];
            return [
              { subject: "Activate", textBody: link, htmlBody: `<a href="${link}">open</a>` },
            ];
          },
        },
      },
    } as unknown as StepContext;
    const result = await REAL_STEP_HANDLERS.email_verify(ctx);
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(result).toMatchObject({
      kind: "step",
      lastAction: "Email verified",
      outcome: { activation: "active" },
    });
    expect(logins).toEqual([]);
    expect(
      session.actions.filter((action) => action.kind === "goto" && action.url === link),
    ).toHaveLength(1);
  });
});
