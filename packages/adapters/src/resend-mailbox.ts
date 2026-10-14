import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  AdapterContext,
  AdapterDescriptor,
  InboundMail,
  MailboxInbox,
  MailboxProvider,
  MailboxProviderCapabilities,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { personMailboxAddress } from "./person-mailbox.js";

/**
 * Resend inbound. Any address at `domain` is received. The webhook carries an id;
 * the body is loaded from the receiving API and stored on `lb_inbound_mail`.
 */
export class ResendMailbox implements MailboxProvider {
  constructor(
    private readonly options: {
      domain: string;
      apiKey: string;
      prisma: PrismaClient;
      fetch?: typeof fetch;
    },
  ) {}

  describe(): AdapterDescriptor<MailboxProviderCapabilities> {
    return {
      id: "resend",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { inbound: "webhook" },
    };
  }

  ensureInbox(projectId: string, _context: AdapterContext): Promise<MailboxInbox> {
    const address = personMailboxAddress(`${projectId}:0`, this.options.domain);
    return Promise.resolve({ inboxId: address, address });
  }

  async listMessages(inboxId: string, options: { since?: Date }): Promise<InboundMail[]> {
    const since = options.since?.getTime();
    const rows = await this.options.prisma.lbInboundMail.findMany({
      where: { inboxId },
      orderBy: { receivedAt: "asc" },
    });
    const stored: InboundMail[] = rows.map((row) => ({
      inboxId: row.inboxId,
      from: row.fromAddress,
      subject: row.subject,
      textBody: row.textBody,
      ...(row.htmlBody ? { htmlBody: row.htmlBody } : {}),
      receivedAt: row.receivedAt.toISOString(),
    }));
    const remote = await this.pullInbox(inboxId);
    return [...stored, ...remote]
      .filter((mail) => since === undefined || Date.parse(mail.receivedAt) >= since)
      .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
  }

  /** Reads the receiving API directly. An empty webhook list still delivers mail. */
  private async pullInbox(inboxId: string): Promise<InboundMail[]> {
    const fetchImpl = this.options.fetch ?? fetch;
    const headers = {
      Authorization: `Bearer ${this.options.apiKey}`,
      Accept: "application/json",
      "User-Agent": "autoSEO-mail",
    };
    let listed = await fetchImpl("https://api.resend.com/emails/receiving", { headers });
    if (!listed.ok) {
      listed = await fetchImpl("https://api.resend.com/emails/receiving", { headers });
    }
    if (!listed.ok) return [];
    const body = (await listed.json()) as { data?: Array<{ id?: string; to?: string[] }> };
    const ids = (body.data ?? [])
      .filter((row) =>
        (row.to ?? []).some((address) => address.toLowerCase() === inboxId.toLowerCase()),
      )
      .map((row) => row.id)
      .filter((id): id is string => Boolean(id));
    const mails: InboundMail[] = [];
    for (const id of ids) {
      const response = await fetchImpl(`https://api.resend.com/emails/receiving/${id}`, {
        headers,
      });
      if (!response.ok) continue;
      const message = (await response.json()) as {
        from?: string;
        subject?: string;
        text?: string;
        html?: string;
        created_at?: string;
      };
      mails.push({
        inboxId,
        from: message.from ?? "unknown",
        subject: message.subject ?? "",
        textBody: message.text ?? "",
        ...(message.html ? { htmlBody: message.html } : {}),
        receivedAt: message.created_at ?? new Date().toISOString(),
      });
    }
    return mails;
  }
}

/** Svix signature used by Resend webhooks. `secret` is the `whsec_…` value. */
export function verifyResendSignature(
  secret: string,
  rawBody: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
): boolean {
  if (!headers.id || !headers.timestamp || !headers.signature) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const signed = createHmac("sha256", key)
    .update(`${headers.id}.${headers.timestamp}.${rawBody}`)
    .digest("base64");
  const offered = headers.signature.split(" ").map((part) => part.split(",")[1] ?? "");
  return offered.some((value) => {
    const left = Buffer.from(value);
    const right = Buffer.from(signed);
    return left.length === right.length && timingSafeEqual(left, right);
  });
}

export interface ResendReceivedMail {
  emailId: string;
  to: string[];
  from: string;
  subject: string;
  text: string;
  html?: string;
  createdAt: string;
}

export function parseResendReceivedEvent(body: unknown): { emailId: string; to: string[] } | null {
  if (!body || typeof body !== "object") return null;
  const event = body as { type?: string; data?: { email_id?: string; to?: string[] } };
  if (event.type !== "email.received" || !event.data?.email_id) return null;
  return { emailId: event.data.email_id, to: event.data.to ?? [] };
}
