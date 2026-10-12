import { parseAgentMailWebhook } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { extractVerificationLink, verifyWebhookSignature } from "@rakazo/linkbuilder-core";

export async function verifyInboundMailSignature(
  secret: string,
  rawBody: string,
  header: string | null,
): Promise<boolean> {
  return verifyWebhookSignature(secret, rawBody, header);
}

/**
 * Maps a signature-checked AgentMail body to the project that owns the inbox and stores the
 * mail. Verification-link extraction runs against each host waiting on email, which is what
 * the worker later opens.
 */
export async function ingestInboundMail(
  prisma: PrismaClient,
  rawBody: string,
): Promise<{ ok: true; projectId: string | null; stored: boolean; link: string | null }> {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { ok: true, projectId: null, stored: false, link: null };
  }
  const mail = parseAgentMailWebhook(body);
  if (!mail) return { ok: true, projectId: null, stored: false, link: null };
  const project = await prisma.lbProject.findFirst({
    where: { mailboxId: mail.inboxId, archivedAt: null },
  });
  if (!project) return { ok: true, projectId: null, stored: false, link: null };
  const eventId =
    body && typeof body === "object" && "event_id" in body && typeof body.event_id === "string"
      ? body.event_id
      : null;
  const hosts = await prisma.lbHost.findMany({
    where: { projectId: project.id, status: "pending_email" },
    select: { homepageUrl: true },
  });
  const link =
    hosts
      .map((host) => extractVerificationLink(mail, host.homepageUrl))
      .find((value): value is string => value !== null) ?? null;
  try {
    await prisma.lbInboundMail.create({
      data: {
        workspaceId: project.workspaceId,
        projectId: project.id,
        inboxId: mail.inboxId,
        eventId,
        fromAddress: mail.from,
        subject: mail.subject,
        textBody: mail.textBody,
        htmlBody: mail.htmlBody,
        receivedAt: new Date(mail.receivedAt),
      },
    });
  } catch (error) {
    if (!isUnique(error)) throw error;
    return { ok: true, projectId: project.id, stored: false, link };
  }
  return { ok: true, projectId: project.id, stored: true, link };
}

/** Stores one Resend inbound message on the project whose mailbox address matches `to`. */
export async function ingestResendMail(
  prisma: PrismaClient,
  mail: {
    to: string;
    from: string;
    subject: string;
    text: string;
    html?: string;
    receivedAt: string;
    eventId: string;
  },
): Promise<{ ok: true; projectId: string | null; stored: boolean }> {
  const project = await prisma.lbProject.findFirst({
    where: { mailboxAddress: mail.to, archivedAt: null },
  });
  if (!project) return { ok: true, projectId: null, stored: false };
  try {
    await prisma.lbInboundMail.create({
      data: {
        workspaceId: project.workspaceId,
        projectId: project.id,
        inboxId: mail.to,
        eventId: mail.eventId,
        fromAddress: mail.from,
        subject: mail.subject,
        textBody: mail.text,
        htmlBody: mail.html ?? null,
        receivedAt: new Date(mail.receivedAt),
      },
    });
  } catch (error) {
    if (!isUnique(error)) throw error;
    return { ok: true, projectId: project.id, stored: false };
  }
  return { ok: true, projectId: project.id, stored: true };
}

function isUnique(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}
