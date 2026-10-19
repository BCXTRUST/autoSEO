import { describe, expect, it } from "vitest";
import { EncryptedSecretStore } from "./secrets.js";
import {
  loadSiteLoginForFill,
  publicVaultFillResult,
  redactVaultToolArgs,
  upsertSiteLogin,
} from "./site-login-tools.js";

describe("vault tool args", () => {
  it("strips passwords before they are recorded", () => {
    expect(
      redactVaultToolArgs("vault_put", {
        site: "https://forum.example.test",
        username: "demo",
        password: "test-password-not-real",
      }),
    ).toEqual({
      site: "https://forum.example.test",
      username: "demo",
      password: "[redacted]",
    });
  });
});

describe("upsertSiteLogin", () => {
  it("encrypts the password and never returns it", async () => {
    const secrets = new EncryptedSecretStore("test-key");
    const created: unknown[] = [];
    const prisma = {
      siteLogin: {
        findUnique: async () => null,
        count: async () => 0,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return {
            id: "login-1",
            host: data.host,
            url: data.url,
            username: data.username,
            share: data.share,
            createdByBotId: data.createdByBotId,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          };
        },
      },
      secret: {
        create: async ({ data }: { data: { ciphertext: string } }) => {
          expect(data.ciphertext).not.toContain("test-password-not-real");
          return { id: "secret-1" };
        },
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    };

    const result = await upsertSiteLogin(
      { prisma: prisma as never, secrets },
      {
        workspaceId: "w",
        userId: "u",
        botId: "b",
        site: "https://www.forum.example.test/signup",
        username: "demo",
        password: "test-password-not-real",
        from: "bot",
      },
    );
    expect(result).toMatchObject({
      login: {
        host: "forum.example.test",
        username: "demo",
        share: "creator",
      },
    });
    expect(JSON.stringify(result)).not.toContain("test-password-not-real");
    expect(created[0]).toMatchObject({ host: "forum.example.test", createdByBotId: "b" });
  });
});

describe("loadSiteLoginForFill", () => {
  it("keeps the password off the public fill result", async () => {
    const secrets = new EncryptedSecretStore("test-key");
    const stored = await secrets.put("owner-password-not-for-model", {
      operationId: "vault",
      traceId: "vault",
      workspaceId: "w",
      userId: "u",
      signal: new AbortController().signal,
    });
    const prisma = {
      siteLogin: {
        findFirst: async () => ({
          id: "login-1",
          host: "forum.example.test",
          url: "https://forum.example.test/login",
          username: "demo",
          share: "workspace",
          createdByBotId: null,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          secret: { ciphertext: stored.ciphertext },
        }),
      },
    };
    let where: unknown;
    prisma.siteLogin.findFirst = async (args: { where: unknown }) => {
      where = args.where;
      return {
        id: "login-1",
        host: "forum.example.test",
        url: "https://forum.example.test/login",
        username: "demo",
        share: "workspace",
        createdByBotId: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        secret: { ciphertext: stored.ciphertext },
      };
    };
    const loaded = await loadSiteLoginForFill(
      { prisma: prisma as never, secrets },
      { workspaceId: "w", userId: "project-owner", botId: "b", loginId: "login-1" },
    );
    expect(where).toEqual({
      id: "login-1",
      workspaceId: "w",
      OR: [
        { userId: "project-owner", OR: [{ share: "workspace" }, { createdByBotId: "b" }] },
        { share: "workspace" },
      ],
    });
    expect("password" in loaded && loaded.password).toBe("owner-password-not-for-model");
    if (!("login" in loaded)) throw new Error("expected login");
    const published = publicVaultFillResult(loaded.login);
    expect(published).toEqual({
      filled: true,
      loginId: "login-1",
      host: "forum.example.test",
      username: "demo",
    });
    expect(JSON.stringify(published)).not.toContain("owner-password");
  });
});
