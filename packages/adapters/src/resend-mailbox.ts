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
    const remote = await this.pullInbox(inboxId, options.since);
    return [...stored, ...remote]
      .filter((mail) => since === undefined || Date.parse(mail.receivedAt) >= since)
      .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
  }

  /**
   * Pages `GET /emails/receiving` with `limit` and `after` until `has_more` is false
   * or the oldest row is already older than `since`.
   */
  private async pullInbox(inboxId: string, since?: Date): Promise<InboundMail[]> {
    const fetchImpl = this.options.fetch ?? fetch;
    const headers = {
      Authorization: `Bearer ${this.options.apiKey}`,
      Accept: "application/json",
      "User-Agent": "autoSEO-mail",
    };
    const want = inboxId.trim().toLowerCase();
    const mails: InboundMail[] = [];
    let after: string | null = null;
    const sinceMs = since?.getTime();
    for (let page = 0; page < 20; page += 1) {
      const url = new URL("https://api.resend.com/emails/receiving");
      url.searchParams.set("limit", "100");
      if (after) url.searchParams.set("after", after);
      let listed = await fetchImpl(url, { headers });
      if (!listed.ok) listed = await fetchImpl(url, { headers });
      if (!listed.ok) break;
      const body = (await listed.json()) as {
        has_more?: boolean;
        data?: Array<{ id?: string; to?: string[]; created_at?: string }>;
      };
      const rows = body.data ?? [];
      if (rows.length === 0) break;
      let oldest = Number.POSITIVE_INFINITY;
      for (const row of rows) {
        const created = Date.parse(row.created_at ?? "");
        if (Number.isFinite(created)) oldest = Math.min(oldest, created);
        const matched = (row.to ?? []).some((address) => address.trim().toLowerCase() === want);
        if (!matched || !row.id) continue;
        if (sinceMs !== undefined && Number.isFinite(created) && created < sinceMs) continue;
        const response = await fetchImpl(`https://api.resend.com/emails/receiving/${row.id}`, {
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
          receivedAt: message.created_at ?? row.created_at ?? new Date().toISOString(),
        });
      }
      const cursor = rows[rows.length - 1]?.id;
      if (!body.has_more || !cursor || cursor === after) break;
      if (sinceMs !== undefined && oldest < sinceMs) break;
      after = cursor;
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
