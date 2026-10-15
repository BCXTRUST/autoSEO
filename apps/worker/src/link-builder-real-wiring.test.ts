import type { AdapterContext, SandboxProvider } from "@rakazo/adapter-kit";
import type { EncryptedSecretStore } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { releasePersonaComputer, searchCredentialsForContext } from "./link-builder-real-wiring.js";

const context = {
  operationId: "link-builder.release",
  traceId: "link-builder.release",
  workspaceId: "workspace-1",
  userId: "user-1",
  signal: new AbortController().signal,
} satisfies AdapterContext;

describe("releaseDesktop", () => {
  it("destroys the sandbox when stop mode is requested", async () => {
    const update = vi.fn(async () => ({}));
    const destroy = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    await releasePersonaComputer({
      prisma: {
        lbProject: {
          findUnique: vi.fn(async () => ({ workspaceId: "workspace-1" })),
        },
        computer: {
          findMany: vi.fn(async () => [
            {
              id: "computer-1",
              homeKey: "team-workspace-1",
              kind: "e2b",
              providerRef: "sandbox-1",
              state: "running",
              workspaceId: "workspace-1",
            },
          ]),
          update,
        },
      } as unknown as PrismaClient,
      sandbox: { destroy, stop } as unknown as SandboxProvider,
      projectId: "project-1",
      context,
      mode: "stop",
    });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: "computer-1" },
      data: { state: "stopped", providerRef: null, screenUrl: null },
    });
  });
});

describe("search credentials", () => {
  function secrets(redacted: string[]) {
    return {
      load: () => "row-login:row-pass",
      redact: (value: string) => {
        redacted.push(value);
      },
    } as unknown as EncryptedSecretStore;
  }

  it("uses the stored row ahead of the environment", async () => {
    const redacted: string[] = [];
    const creds = await searchCredentialsForContext({
      env: { DATAFORSEO_LOGIN: "test-login", DATAFORSEO_PASSWORD: "test-pass" },
      prisma: {
        secret: { findFirst: async () => ({ ciphertext: "cipher" }) },
      } as unknown as PrismaClient,
      secrets: secrets(redacted),
      context,
    });
    expect(creds).toEqual({ login: "row-login", password: "row-pass" });
    expect(redacted).toContain("row-login:row-pass");
  });

  it("uses both environment values when no row exists", async () => {
    const redacted: string[] = [];
    const creds = await searchCredentialsForContext({
      env: { DATAFORSEO_LOGIN: "test-login", DATAFORSEO_PASSWORD: "test-pass" },
      prisma: { secret: { findFirst: async () => null } } as unknown as PrismaClient,
      secrets: secrets(redacted),
      context,
    });
    expect(creds).toEqual({ login: "test-login", password: "test-pass" });
    expect(redacted).toEqual(["test-login", "test-pass"]);
  });

  it("throws when no row exists and one environment value is missing", async () => {
    await expect(
      searchCredentialsForContext({
        env: { DATAFORSEO_LOGIN: "test-login" },
        prisma: { secret: { findFirst: async () => null } } as unknown as PrismaClient,
        secrets: secrets([]),
        context,
      }),
    ).rejects.toThrow("missing search credentials");
  });
});
