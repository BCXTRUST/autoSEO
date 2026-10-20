const GIVEN = [
  "lena",
  "julia",
  "laura",
  "marie",
  "lisa",
  "hanna",
  "sophie",
  "emma",
  "mia",
  "lea",
  "nina",
  "jonas",
  "lukas",
  "felix",
  "paul",
  "tobias",
] as const;

const FAMILY = [
  "hoffmann",
  "schneider",
  "fischer",
  "weber",
  "wagner",
  "becker",
  "bauer",
  "richter",
  "klein",
  "wolf",
  "neumann",
  "schwarz",
  "braun",
  "hartmann",
  "lange",
  "krause",
  "meier",
  "lehmann",
  "huber",
] as const;

/** A new local part after this many signups. Older addresses stay readable. */
export const MAILBOX_USES_PER_ADDRESS = 10;

function hash(seed: string): number {
  let value = 2166136261;
  for (const char of seed) {
    value ^= char.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function cleanDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^@/, "");
}

/** `lena.hoffmann@sideinbox.email`. The same seed always returns the same person. */
export function personMailboxAddress(seed: string, domain: string): string {
  const n = hash(seed);
  const given = GIVEN[n % GIVEN.length] ?? "lena";
  const family = FAMILY[Math.floor(n / GIVEN.length) % FAMILY.length] ?? "hoffmann";
  return `${given}.${family}@${cleanDomain(domain)}`;
}

export function mailboxGeneration(priorSignups: number): number {
  const count = Number.isFinite(priorSignups) ? Math.max(0, Math.floor(priorSignups)) : 0;
  return Math.floor(count / MAILBOX_USES_PER_ADDRESS);
}

/** True for an AgentMail inbox or a generated `lb-…` local part. */
export function isLegacyAgentMailbox(address: string | null | undefined): boolean {
  if (!address) return false;
  const lower = address.trim().toLowerCase();
  const at = lower.lastIndexOf("@");
  const local = at === -1 ? lower : lower.slice(0, at);
  const host = at === -1 ? "" : lower.slice(at + 1);
  if (host === "agentmail.to" || host.endsWith(".agentmail.to")) return true;
  return local.startsWith("lb-") || local.startsWith("lb_");
}

/**
 * Address typed into a new signup. A person-like address already stored is
 * kept. A legacy `lb-` or AgentMail address is never typed again. A new
 * account gets a person on the Resend domain.
 */
export function signupMailboxAddress(input: {
  existingAccount: boolean;
  storedAddress: string | null;
  seed: string;
  domain: string | null | undefined;
  priorSignups: number;
}): string | null {
  const stored = input.storedAddress?.trim() || null;
  const kept = stored && !isLegacyAgentMailbox(stored) ? stored : null;
  if (input.existingAccount && kept) return kept;
  const domain = input.domain?.trim();
  if (!domain) return kept;
  const generation = mailboxGeneration(input.priorSignups);
  return personMailboxAddress(`${input.seed}:${generation}`, domain);
}

/** Every inbox that might already hold mail for this project, oldest included. */
export function mailboxAddressesToRead(input: {
  seed: string;
  domain: string | null | undefined;
  priorSignups: number;
  storedIds: ReadonlyArray<string | null | undefined>;
}): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    ids.push(trimmed);
  };
  for (const id of input.storedIds) add(id);
  const domain = input.domain?.trim();
  if (domain) {
    const generation = mailboxGeneration(input.priorSignups);
    for (let index = 0; index <= generation; index += 1) {
      add(personMailboxAddress(`${input.seed}:${index}`, domain));
    }
  }
  return ids;
}
