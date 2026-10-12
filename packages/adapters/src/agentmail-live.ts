import type {
  AdapterContext,
  AdapterDescriptor,
  InboundMail,
  MailboxInbox,
  MailboxProvider,
  MailboxProviderCapabilities,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";

/**
 * Live AgentMail inbox. HTTP stays behind this class; tests pass a fake client and never
 * call api.agentmail.to. The live check is a deployment with `AGENTMAIL_API_KEY` creating
 * `POST /v0/inboxes`, plus `AGENTMAIL_WEBHOOK_SECRET` on the inbound route.
 */
export interface AgentMailLiveClient {
  listInboxes(): Promise<
    Array<{ inboxId: string; email: string; projectId: string | null; workspaceId: string | null }>
  >;
  createInbox(input: {
    username: string;
    displayName?: string;
    projectId: string;
    workspaceId: string;
  }): Promise<{ inboxId: string; email: string }>;
  listMessages?(inboxId: string): Promise<InboundMail[]>;
}

/** Live HTTP client. Tests should pass a fake `AgentMailLiveClient` instead of calling this. */
export function agentMailLiveClient(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): AgentMailLiveClient {
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
  return {
    async listInboxes() {
      const response = await fetchImpl("https://api.agentmail.to/v0/inboxes?limit=50", { headers });
      if (!response.ok) throw new Error(`AgentMail HTTP ${response.status}`);
      const body = (await response.json()) as {
        inboxes?: Array<{
          inbox_id?: string;
          inboxId?: string;
          email?: string;
          metadata?: Record<string, string | number | boolean | null>;
        }>;
      };
      return (body.inboxes ?? []).map((inbox) => {
        const inboxId = String(inbox.inbox_id ?? inbox.inboxId ?? "");
        const projectId = inbox.metadata?.rakazoProjectId;
        return {
          inboxId,
          email: String(inbox.email ?? inboxId),
          projectId: typeof projectId === "string" ? projectId : null,
          workspaceId: null,
        };
      });
    },
    async createInbox(input) {
      const response = await fetchImpl("https://api.agentmail.to/v0/inboxes", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          username: input.username,
          display_name: input.displayName,
          metadata: { rakazoProjectId: input.projectId, workspaceId: input.workspaceId },
        }),
      });
      if (!response.ok) throw new Error(`AgentMail HTTP ${response.status}`);
      const body = (await response.json()) as {
        inbox_id?: string;
        inboxId?: string;
        email?: string;
      };
      const inboxId = String(body.inbox_id ?? body.inboxId ?? "");
      return { inboxId, email: String(body.email ?? inboxId) };
    },
    async listMessages(inboxId) {
      const load = () =>
        fetchImpl(
          `https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inboxId)}/messages?limit=20&include_spam=true`,
          { headers },
        );
      let listed = await load();
      if (!listed.ok) listed = await load();
      if (!listed.ok) throw new Error(`AgentMail HTTP ${listed.status}`);
      const page = (await listed.json()) as {
        messages?: Array<{ message_id?: string; messageId?: string }>;
      };
      const mails: InboundMail[] = [];
      for (const item of page.messages ?? []) {
        const messageId = item.message_id ?? item.messageId;
        if (!messageId) continue;
        const response = await fetchImpl(
          `https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}`,
          { headers },
        );
        if (!response.ok) throw new Error(`AgentMail HTTP ${response.status}`);
        mails.push(inboundMail(inboxId, (await response.json()) as Record<string, unknown>));
      }
      return mails;
    },
  };
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function inboundMail(inboxId: string, message: Record<string, unknown>): InboundMail {
  const received = stringField(message.timestamp) || new Date(0).toISOString();
  return {
    inboxId,
    from: stringField(message.from) || "unknown",
    subject: stringField(message.subject),
    textBody:
      stringField(message.text) ||
      stringField(message.extracted_text) ||
      stringField(message.preview),
    htmlBody: stringField(message.html) || stringField(message.extracted_html) || undefined,
    receivedAt: received,
  };
}

export class AgentMailMailbox implements MailboxProvider {
  constructor(
    private readonly client: AgentMailLiveClient,
    private readonly prisma?: PrismaClient,
  ) {}

  describe(): AdapterDescriptor<MailboxProviderCapabilities> {
    return {
      id: "agentmail",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { inbound: "webhook" },
    };
  }

  async ensureInbox(projectId: string, context: AdapterContext): Promise<MailboxInbox> {
    const existing = (await this.client.listInboxes()).find(
      (inbox) => inbox.projectId === projectId,
    );
    if (existing) return { inboxId: existing.inboxId, address: existing.email };
    const username = `lb-${projectId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`.slice(0, 40);
    const created = await this.client.createInbox({
      username,
      projectId,
      workspaceId: context.workspaceId,
    });
    return { inboxId: created.inboxId, address: created.email };
  }

  async listMessages(
    inboxId: string,
    options: { since?: Date },
    _context: AdapterContext,
  ): Promise<InboundMail[]> {
    const since = options.since?.getTime();
    const stored = this.prisma
      ? await this.prisma.lbInboundMail.findMany({
          where: { inboxId },
          orderBy: { receivedAt: "asc" },
        })
      : [];
    const remote = (await this.client.listMessages?.(inboxId)) ?? [];
    const fromDb: InboundMail[] = stored.map((row) => ({
      inboxId: row.inboxId,
      from: row.fromAddress,
      subject: row.subject,
      textBody: row.textBody,
      htmlBody: row.htmlBody ?? undefined,
      receivedAt: row.receivedAt.toISOString(),
    }));
    return [...fromDb, ...remote]
      .filter((mail) => since === undefined || Date.parse(mail.receivedAt) >= since)
      .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
  }
}
