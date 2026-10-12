import type { NotificationProvider } from "@rakazo/adapter-kit";
import type { EncryptedSecretStore } from "@rakazo/adapters";
import { LbOperatorSettingsSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  type AlertEvent,
  type AlertSink,
  type HostnameResolver,
  webhookNextAttempt,
  webhookSignatureHeader,
  webhookUrlAllowed,
} from "@rakazo/linkbuilder-core";

const TICKET_ROUTE = "/link-builder-ticket";

export function createAlertSink(deps: {
  prisma: PrismaClient;
  secrets: EncryptedSecretStore;
  notifications?: NotificationProvider;
  now: Date;
  productionWebhooks: boolean;
  resolveHostname?: HostnameResolver;
}): AlertSink {
  return {
    async emit(event) {
      try {
        const alert = await deps.prisma.lbAlert.create({
          data: {
            workspaceId: event.workspaceId,
            projectId: event.projectId,
            kind: event.kind,
            dedupeKey: event.dedupeKey,
            message: event.message,
            payload: event.payload,
            createdAt: deps.now,
          },
        });
        await notify(deps, event, alert.id);
        return "sent";
      } catch (error) {
        if (isUnique(error)) return "duplicate";
        throw error;
      }
    },
  };
}

async function notify(
  deps: {
    prisma: PrismaClient;
    secrets: EncryptedSecretStore;
    notifications?: NotificationProvider;
    now: Date;
    productionWebhooks: boolean;
    resolveHostname?: HostnameResolver;
  },
  event: AlertEvent,
  alertId: string,
) {
  const project = await deps.prisma.lbProject.findUnique({
    where: { id: event.projectId },
    select: { operator: true, webhookUrl: true, webhookSecretId: true, createdByUserId: true },
  });
  if (!project) return;
  const operator = LbOperatorSettingsSchema.safeParse(project.operator);
  const channels = operator.success ? operator.data.channels : ["push"];
  const ticketId = typeof event.payload.ticketId === "string" ? event.payload.ticketId : "";
  const url = `${TICKET_ROUTE}?projectId=${encodeURIComponent(event.projectId)}${ticketId ? `&ticketId=${encodeURIComponent(ticketId)}` : ""}`;
  if (channels.includes("push") && deps.notifications) {
    await deps.notifications
      .send(
        {
          kind: "link_builder",
          title: event.message,
          body: event.message,
          botId: event.projectId,
          threadId: ticketId || event.projectId,
          url,
        },
        {
          operationId: `lb-alert:${alertId}`,
          traceId: `lb-alert:${alertId}`,
          workspaceId: event.workspaceId,
          userId: project.createdByUserId,
          signal: new AbortController().signal,
        },
      )
      .catch(() => undefined);
  }
  if (!project.webhookUrl || !project.webhookSecretId) return;
  const allowed = await webhookUrlAllowed(project.webhookUrl, {
    production: deps.productionWebhooks,
    resolve: deps.productionWebhooks ? deps.resolveHostname : undefined,
  });
  const next = webhookNextAttempt(0, deps.now);
  await deps.prisma.lbWebhookDelivery.create({
    data: {
      workspaceId: event.workspaceId,
      projectId: event.projectId,
      alertId,
      attempt: 1,
      status: allowed.ok ? "pending" : "failed",
      nextAttemptAt: allowed.ok ? next : null,
      createdAt: deps.now,
    },
  });
}

export async function deliverDueWebhooks(deps: {
  prisma: PrismaClient;
  secrets: EncryptedSecretStore;
  now: Date;
  fetchImpl?: typeof fetch;
  productionWebhooks: boolean;
  resolveHostname?: HostnameResolver;
}): Promise<number> {
  const due = await deps.prisma.lbWebhookDelivery.findMany({
    where: { status: "pending", nextAttemptAt: { lte: deps.now } },
    include: { alert: true, project: true },
    orderBy: { createdAt: "asc" },
    take: 20,
  });
  let delivered = 0;
  for (const row of due) {
    const url = row.project.webhookUrl;
    const secretId = row.project.webhookSecretId;
    const allowed = url
      ? await webhookUrlAllowed(url, {
          production: deps.productionWebhooks,
          resolve: deps.productionWebhooks ? deps.resolveHostname : undefined,
        })
      : { ok: false as const, reason: "missing" };
    if (!url || !secretId || !allowed.ok) {
      await deps.prisma.lbWebhookDelivery.update({
        where: { id: row.id },
        data: { status: "failed", nextAttemptAt: null },
      });
      continue;
    }
    const stored = await deps.prisma.secret.findUnique({ where: { id: secretId } });
    if (!stored) {
      await deps.prisma.lbWebhookDelivery.update({
        where: { id: row.id },
        data: { status: "failed", nextAttemptAt: null },
      });
      continue;
    }
    let secret = "";
    try {
      secret = deps.secrets.load(stored.ciphertext);
    } catch {
      await deps.prisma.lbWebhookDelivery.update({
        where: { id: row.id },
        data: { status: "failed", nextAttemptAt: null },
      });
      continue;
    }
    const body = JSON.stringify({
      kind: row.alert.kind,
      projectId: row.projectId,
      message: row.alert.message,
      payload: row.alert.payload,
      at: deps.now.toISOString(),
    });
    const header = await webhookSignatureHeader(secret, body);
    let statusCode = 0;
    let ok = false;
    try {
      const response = await (deps.fetchImpl ?? fetch)(url, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "X-autoSEO-Signature": header,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      statusCode = response.status;
      ok = response.ok;
    } catch {
      ok = false;
    }
    if (ok) {
      await deps.prisma.lbWebhookDelivery.update({
        where: { id: row.id },
        data: { status: "delivered", statusCode, nextAttemptAt: null },
      });
      delivered += 1;
      continue;
    }
    await deps.prisma.lbWebhookDelivery.update({
      where: { id: row.id },
      data: { status: "failed", statusCode: statusCode || null, nextAttemptAt: null },
    });
    const again = webhookNextAttempt(row.attempt, deps.now);
    if (again) {
      await deps.prisma.lbWebhookDelivery.create({
        data: {
          workspaceId: row.workspaceId,
          projectId: row.projectId,
          alertId: row.alertId,
          attempt: row.attempt + 1,
          status: "pending",
          nextAttemptAt: again,
          createdAt: deps.now,
        },
      });
    }
  }
  return delivered;
}

function isUnique(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}
