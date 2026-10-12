import type { RandomBytes } from "./credentials.js";

const defaultRandomBytes: RandomBytes = (length) => crypto.getRandomValues(new Uint8Array(length));

/** Common given names and surnames. A forum persona is a person, never the shop. */
const NAMES: Record<string, { given: readonly string[]; family: readonly string[] }> = {
  de: {
    given: [
      "Anna",
      "Lena",
      "Julia",
      "Laura",
      "Marie",
      "Lisa",
      "Hannah",
      "Sophie",
      "Emma",
      "Mia",
      "Lea",
      "Johanna",
      "Katharina",
      "Nina",
      "Claudia",
      "Sabine",
      "Thomas",
      "Michael",
      "Andreas",
      "Stefan",
      "Christian",
      "Markus",
      "Daniel",
      "Martin",
      "Felix",
      "Lukas",
      "Jonas",
      "Paul",
      "Tobias",
    ],
    family: [
      "Müller",
      "Schmidt",
      "Schneider",
      "Fischer",
      "Weber",
      "Wagner",
      "Becker",
      "Hoffmann",
      "Schäfer",
      "Koch",
      "Bauer",
      "Richter",
      "Klein",
      "Wolf",
      "Neumann",
      "Schwarz",
      "Zimmermann",
      "Braun",
      "Krüger",
      "Hartmann",
      "Lange",
      "Werner",
      "Krause",
      "Meier",
      "Lehmann",
      "König",
      "Huber",
    ],
  },
  en: {
    given: [
      "Emma",
      "Olivia",
      "Sophia",
      "Mia",
      "Amelia",
      "Hannah",
      "Grace",
      "Nora",
      "Ella",
      "Lily",
      "James",
      "Oliver",
      "William",
      "Henry",
      "Jack",
      "Leo",
      "Oscar",
      "Arthur",
      "George",
      "Samuel",
    ],
    family: [
      "Smith",
      "Johnson",
      "Brown",
      "Jones",
      "Miller",
      "Davis",
      "Wilson",
      "Taylor",
      "Anderson",
      "Thomas",
      "Moore",
      "Martin",
      "Clark",
      "Walker",
      "Hall",
      "Young",
      "Allen",
      "King",
      "Wright",
      "Hill",
    ],
  },
};

function catalog(language: string): { given: readonly string[]; family: readonly string[] } {
  const code = language.trim().toLowerCase().split("-")[0] ?? "en";
  return NAMES[code] ?? NAMES.en!;
}

function fold(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(value: string): string[] {
  return fold(value)
    .split(" ")
    .filter((token) => token.length >= 4);
}

export function brandNameSources(input: {
  brandName?: string | null;
  projectName?: string | null;
  slug?: string | null;
  domains?: readonly string[] | null;
}): string[] {
  return [input.brandName, input.projectName, input.slug, ...(input.domains ?? [])]
    .map((value) => value?.trim() ?? "")
    .filter((value) => value.length > 0);
}

/** True when the label is empty or shares a meaningful token with the shop, project, or domain. */
export function personaNameIsBrandDerived(displayName: string, sources: readonly string[]): boolean {
  const name = fold(displayName);
  if (!name || name === "persona" || name === "member") return true;
  for (const source of sources) {
    const folded = fold(source);
    if (folded.length >= 4 && (name === folded || name.includes(folded))) return true;
    for (const token of tokens(source)) {
      if (name.includes(token)) return true;
      for (const part of tokens(displayName)) {
        if (part.length >= 5 && token.includes(part)) return true;
      }
    }
  }
  return false;
}

function pickIndex(length: number, randomBytes: RandomBytes): number {
  if (length <= 1) return 0;
  const limit = 256 - (256 % length);
  while (true) {
    const byte = randomBytes(1)[0] ?? 0;
    if (byte < limit) return byte % length;
  }
}

/** A first name and surname that fit the market language. */
export function pickPersonalName(
  language: string,
  randomBytes: RandomBytes = defaultRandomBytes,
): string {
  const names = catalog(language);
  const given = names.given[pickIndex(names.given.length, randomBytes)] ?? "Alex";
  const family = names.family[pickIndex(names.family.length, randomBytes)] ?? "Berg";
  return `${given} ${family}`;
}

/**
 * Keep a name the operator typed when it is a person. Replace a blank or brand-derived label
 * with a random personal name for the project's language.
 */
export function resolvePersonaDisplayName(input: {
  displayName: string;
  language: string;
  sources: readonly string[];
  randomBytes?: RandomBytes;
}): string {
  const current = input.displayName.trim();
  if (current && !personaNameIsBrandDerived(current, input.sources)) return current;
  const randomBytes = input.randomBytes ?? defaultRandomBytes;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const picked = pickPersonalName(input.language, randomBytes);
    if (!personaNameIsBrandDerived(picked, input.sources)) return picked;
  }
  return pickPersonalName(input.language, randomBytes);
}
