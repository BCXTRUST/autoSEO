import { normalizeSiteLoginHost, siteLoginUrl } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import type { EncryptedSecretStore } from "./secrets.js";

export const SITE_LOGIN_SHARES = ["workspace", "creator"] as const;
export type SiteLoginShare = (typeof SITE_LOGIN_SHARES)[number];

const USERNAME_MAX = 200;
const PASSWORD_MAX = 500;
const URL_MAX = 2_048;
const MAX_LOGINS_PER_USER = 100;

export type SiteLoginToolDeps = {
  prisma: PrismaClient;
  secrets: EncryptedSecretStore;
};

export type SiteLoginPublic = {
  id: string;
  host: string;
  url: string;
  username: string;
  share: SiteLoginShare;
  createdByBotId: string | null;
  createdAt: string;
  updatedAt: string;
};

type SiteLoginRow = {
  id: string;
  host: string;
  url: string | null;
  username: string;
  share: string;
  createdByBotId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export function isSiteLoginShare(value: unknown): value is SiteLoginShare {
  return typeof value === "string" && (SITE_LOGIN_SHARES as readonly string[]).includes(value);
}

export function coerceSiteLoginShare(value: unknown, fallback: SiteLoginShare): SiteLoginShare {
  return isSiteLoginShare(value) ? value : fallback;
}

export function siteLoginAccessWhere(botId: string): Prisma.SiteLoginWhereInput {
  return {
    OR: [{ share: "workspace" }, { createdByBotId: botId }],
  };
}

export function mapSiteLoginPublic(row: SiteLoginRow): SiteLoginPublic {
  return {
    id: row.id,
    host: row.host,
    url: siteLoginUrl(row.host, row.url),
    username: row.username,
    share: coerceSiteLoginShare(row.share, "workspace"),
    createdByBotId: row.createdByBotId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function redactVaultToolArgs(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!("password" in args) && name !== "vault_put") return args;
  if (!("password" in args)) return args;
  return { ...args, password: "[redacted]" };
}

function abortContext(workspaceId: string, userId: string) {
  return {
    operationId: "vault",
    traceId: "vault",
    workspaceId,
    userId,
    signal: new AbortController().signal,
  };
}

export async function listSiteLogins(
  deps: Pick<SiteLoginToolDeps, "prisma">,
  input: { workspaceId: string; userId: string; botId: string; includeOrphans?: boolean },
) {
  const rows = await deps.prisma.siteLogin.findMany({
    where: {
      workspaceId: input.workspaceId,
      userId: input.userId,
      OR: [
        { share: "workspace" },
        { createdByBotId: input.botId },
        ...(input.includeOrphans ? [{ share: "creator" as const, createdByBotId: null }] : []),
      ],
    },
    orderBy: [{ host: "asc" }, { username: "asc" }],
  });
  return rows.map(mapSiteLoginPublic);
}

export async function listSiteLoginsFromTool(
  deps: Pick<SiteLoginToolDeps, "prisma">,
  input: { workspaceId: string; userId: string; botId: string; site?: string },
) {
  const items = await listSiteLogins(deps, input);
  if (!input.site?.trim()) return { items };
  let host: string;
  try {
    host = normalizeSiteLoginHost(input.site);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Invalid site." };
  }
  return { items: items.filter((item) => item.host === host) };
}

export async function listSiteLoginPlaintextsForRedact(
  deps: SiteLoginToolDeps,
  input: { workspaceId: string; userId: string; botId: string },
): Promise<string[]> {
  const rows = await deps.prisma.siteLogin.findMany({
    where: {
      workspaceId: input.workspaceId,
      userId: input.userId,
      ...siteLoginAccessWhere(input.botId),
    },
    include: { secret: true },
  });
  const values: string[] = [];
  for (const row of rows) {
    try {
      const password = deps.secrets.load(row.secret.ciphertext);
      if (password) values.push(password);
    } catch {
      /* skip undecryptable rows */
    }
  }
  return values;
}

export async function loadSiteLoginForFill(
  deps: SiteLoginToolDeps,
  input: {
    workspaceId: string;
    userId: string;
    botId: string;
    loginId?: string;
    site?: string;
    username?: string;
  },
): Promise<{ error: string; usernames?: string[] } | { login: SiteLoginPublic; password: string }> {
  const loginId = input.loginId?.trim();
  if (loginId) {
    const row = await deps.prisma.siteLogin.findFirst({
      where: {
        id: loginId,
        workspaceId: input.workspaceId,
        userId: input.userId,
        ...siteLoginAccessWhere(input.botId),
      },
      include: { secret: true },
    });
    if (!row) return { error: "Vault login not found." };
    return { login: mapSiteLoginPublic(row), password: deps.secrets.load(row.secret.ciphertext) };
  }

  const site = input.site?.trim();
  if (!site) return { error: "Pass loginId from vault_list, or a site." };
  let host: string;
  try {
    host = normalizeSiteLoginHost(site);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Invalid site." };
  }
  const username = input.username?.trim();
  const rows = await deps.prisma.siteLogin.findMany({
    where: {
      workspaceId: input.workspaceId,
      userId: input.userId,
      host,
      ...(username ? { username } : {}),
      ...siteLoginAccessWhere(input.botId),
    },
    include: { secret: true },
    orderBy: [{ createdByBotId: "desc" }, { updatedAt: "desc" }],
  });
  if (rows.length === 0) return { error: "No vault login for that site." };
  if (rows.length > 1 && !username) {
    return {
      error: "Several accounts match that site. Pass username or loginId.",
      usernames: rows.map((row) => row.username),
    };
  }
  const row = rows[0]!;
  return { login: mapSiteLoginPublic(row), password: deps.secrets.load(row.secret.ciphertext) };
}

export function publicVaultFillResult(login: SiteLoginPublic) {
  return {
    filled: true as const,
    loginId: login.id,
    host: login.host,
    username: login.username,
  };
}

export async function upsertSiteLogin(
  deps: SiteLoginToolDeps,
  input: {
    workspaceId: string;
    userId: string;
    botId: string;
    site: string;
    username: string;
    password: string;
    share?: string;
    from: "user" | "bot";
  },
): Promise<{ login: SiteLoginPublic } | { error: string }> {
  let host: string;
  try {
    host = normalizeSiteLoginHost(input.site);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Invalid site." };
  }
  const username = input.username.trim();
  if (!username) return { error: "username is required." };
  if (username.length > USERNAME_MAX) {
    return { error: `username must be at most ${USERNAME_MAX} characters.` };
  }
  const password = input.password;
  if (!password) return { error: "password is required." };
  if (password.length > PASSWORD_MAX) {
    return { error: `password must be at most ${PASSWORD_MAX} characters.` };
  }
  const fallbackShare: SiteLoginShare = input.from === "bot" ? "creator" : "workspace";
  const share = coerceSiteLoginShare(input.share, fallbackShare);
  const createdByBotId =
    input.from === "bot" ? input.botId : share === "creator" ? input.botId : null;
  let url: string | null = null;
  const rawSite = input.site.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawSite)) {
    try {
      url = new URL(rawSite).toString().slice(0, URL_MAX);
    } catch {
      url = siteLoginUrl(host);
    }
  }

  const existing = await deps.prisma.siteLogin.findUnique({
    where: {
      workspaceId_userId_host_username: {
        workspaceId: input.workspaceId,
        userId: input.userId,
        host,
        username,
      },
    },
  });
  if (existing) {
    const accessible = existing.share === "workspace" || existing.createdByBotId === input.botId;
    if (!accessible) {
      return { error: "A login for that site already exists and this bot cannot change it." };
    }
    if (
      input.from === "bot" &&
      existing.share === "workspace" &&
      existing.createdByBotId !== input.botId
    ) {
      return { error: "A shared login for that site already exists. Ask the user to update it." };
    }
  } else {
    const count = await deps.prisma.siteLogin.count({
      where: { workspaceId: input.workspaceId, userId: input.userId },
    });
    if (count >= MAX_LOGINS_PER_USER) {
      return { error: `Vault is full (${MAX_LOGINS_PER_USER} logins).` };
    }
  }

  const stored = await deps.secrets.put(password, abortContext(input.workspaceId, input.userId));

  const row = await deps.prisma.$transaction(async (tx) => {
    const secret = await tx.secret.create({
      data: {
        id: stored.id,
        userId: input.userId,
        workspaceId: input.workspaceId,
        kind: "site-login",
        ciphertext: stored.ciphertext,
      },
    });
    if (!existing) {
      return tx.siteLogin.create({
        data: {
          workspaceId: input.workspaceId,
          userId: input.userId,
          host,
          url,
          username,
          secretId: secret.id,
          createdByBotId,
          share,
        },
      });
    }
    const updated = await tx.siteLogin.update({
      where: { id: existing.id },
      data: {
        url: url ?? existing.url,
        secretId: secret.id,
        share,
        createdByBotId: createdByBotId ?? existing.createdByBotId,
      },
    });
    const sharedSecret = await tx.siteLogin.count({
      where: { id: { not: existing.id }, secretId: existing.secretId },
    });
    if (sharedSecret === 0) {
      await tx.secret.deleteMany({ where: { id: existing.secretId } });
    }
    return updated;
  });

  return { login: mapSiteLoginPublic(row) };
}

export async function upsertSiteLoginFromTool(
  deps: SiteLoginToolDeps,
  input: {
    workspaceId: string;
    userId: string;
    botId: string;
    site: string;
    username: string;
    password: string;
  },
) {
  return upsertSiteLogin(deps, { ...input, from: "bot" });
}

export async function removeSiteLogin(
  deps: Pick<SiteLoginToolDeps, "prisma">,
  input: {
    workspaceId: string;
    userId: string;
    botId: string;
    loginId: string;
    from: "user" | "bot";
  },
) {
  const loginId = input.loginId.trim();
  if (!loginId) return { error: "loginId is required." };
  const existing = await deps.prisma.siteLogin.findFirst({
    where: {
      id: loginId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      ...(input.from === "bot"
        ? siteLoginAccessWhere(input.botId)
        : {
            OR: [{ share: "workspace" }, { createdByBotId: input.botId }, { createdByBotId: null }],
          }),
    },
  });
  if (!existing) return { error: "Vault login not found." };
  if (
    input.from === "bot" &&
    existing.share === "workspace" &&
    existing.createdByBotId !== input.botId
  ) {
    return { error: "This bot cannot delete a shared login." };
  }
  await deps.prisma.$transaction(async (tx) => {
    await tx.siteLogin.delete({ where: { id: existing.id } });
    const sharedSecret = await tx.siteLogin.count({ where: { secretId: existing.secretId } });
    if (sharedSecret === 0) {
      await tx.secret.deleteMany({ where: { id: existing.secretId } });
    }
  });
  return {
    ok: true as const,
    loginId: existing.id,
    host: existing.host,
    username: existing.username,
  };
}

export async function removeSiteLoginFromTool(
  deps: Pick<SiteLoginToolDeps, "prisma">,
  input: { workspaceId: string; userId: string; botId: string; loginId: string },
) {
  return removeSiteLogin(deps, { ...input, from: "bot" });
}
