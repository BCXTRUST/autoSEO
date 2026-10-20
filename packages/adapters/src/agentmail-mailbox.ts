import {
  type AdapterContext,
  type AdapterDescriptor,
  type InboundMail,
  InboundMailSchema,
  type MailboxInbox,
  type MailboxProvider,
  type MailboxProviderCapabilities,
} from "@rakazo/adapter-kit";
import { z } from "zod";
import { personMailboxAddress } from "./person-mailbox.js";

/*
 * AgentMail inbound mail, provider side. The webhook body is translated to the neutral
 * `InboundMail` here so nothing outside this adapter knows AgentMail's field names.
 */

const AddressSchema = z.union([
  z.string().min(1),
  z.object({ email: z.string().min(1), name: z.string().optional() }).transform((a) => a.email),
]);

export const AgentMailWebhookSchema = z.object({
  event_type: z.literal("message.received"),
  event_id: z.string().min(1).optional(),
  message: z.object({
    inbox_id: z.string().min(1),
    message_id: z.string().min(1).optional(),
    from: z.union([AddressSchema, z.array(AddressSchema).min(1)]),
    subject: z.string().default(""),
    text: z.string().optional(),
    html: z.string().optional(),
    timestamp: z.string().datetime({ offset: true }).optional(),
    created_at: z.string().datetime({ offset: true }).optional(),
  }),
});

/** Parses a `message.received` webhook body; returns null for other events or malformed bodies. */
export function parseAgentMailWebhook(body: unknown): InboundMail | null {
  const parsed = AgentMailWebhookSchema.safeParse(body);
  if (!parsed.success) return null;
  const message = parsed.data.message;
  const from = Array.isArray(message.from) ? message.from[0]! : message.from;
  return InboundMailSchema.parse({
    inboxId: message.inbox_id,
    from,
    subject: message.subject,
    textBody: message.text ?? "",
    htmlBody: message.html,
    receivedAt: message.timestamp ?? message.created_at ?? new Date().toISOString(),
  });
}

/**
 * In-memory AgentMail stand-in for offline runs: inboxes are registered or created per project,
 * mail arrives through the same webhook body the real service posts.
 */
export class AgentMailEmulator implements MailboxProvider {
  private readonly inboxes = new Map<string, MailboxInbox>();
  private readonly byProject = new Map<string, string>();
  private readonly mail: InboundMail[] = [];
  private readonly seenEvents = new Set<string>();

  constructor(private readonly domain = "inbox.example") {}

  describe(): AdapterDescriptor<MailboxProviderCapabilities> {
    return {
      id: "agentmail-emulator",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { inbound: "webhook" },
    };
  }

  registerInbox(projectId: string, inbox: MailboxInbox): void {
    this.inboxes.set(inbox.inboxId, inbox);
    this.byProject.set(projectId, inbox.inboxId);
  }

  async ensureInbox(projectId: string, _context: AdapterContext): Promise<MailboxInbox> {
    const existing = this.byProject.get(projectId);
    if (existing) return this.inboxes.get(existing)!;
    const address = personMailboxAddress(`${projectId}:0`, this.domain);
    const inbox = { inboxId: address, address };
    this.registerInbox(projectId, inbox);
    return inbox;
  }

  inboxForAddress(address: string): MailboxInbox | undefined {
    const lower = address.toLowerCase();
    return [...this.inboxes.values()].find((inbox) => inbox.address.toLowerCase() === lower);
  }

  /** Accepts a webhook body; duplicates (same event id) and unknown inboxes are ignored. */
  receiveWebhook(body: unknown): boolean {
    const mail = parseAgentMailWebhook(body);
    if (!mail || !this.inboxes.has(mail.inboxId)) return false;
    const eventId = AgentMailWebhookSchema.safeParse(body).data?.event_id;
    if (eventId) {
      if (this.seenEvents.has(eventId)) return false;
      this.seenEvents.add(eventId);
    }
    this.mail.push(mail);
    return true;
  }

  async listMessages(
    inboxId: string,
    options: { since?: Date },
    _context: AdapterContext,
  ): Promise<InboundMail[]> {
    const since = options.since?.getTime();
    return this.mail
      .filter((mail) => mail.inboxId === inboxId)
      .filter((mail) => since === undefined || Date.parse(mail.receivedAt) >= since)
      .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
  }
}
