/** Product default on OpenRouter. Flash and similar are too weak to drive the computer. */
export const DEFAULT_OPENROUTER_MODEL_ID = "x-ai/grok-4.6";

/** Cheap model for compaction, titles, and other non-computer work. */
export const DEFAULT_AUX_MODEL_ID = "google/gemini-2.5-flash";

export const LEGACY_FLASH_MODEL_ID = "deepseek/deepseek-v4-flash-0731";

const WEAK_COMPUTER_MODEL =
  /(?:^|\/)(?:aion(?:[-.\s]*2(?:\.0)?)?|gpt-4\.1-mini|gpt-4o-mini|deepseek-v4-flash)/i;

function strongComputerModelFromEnv(): string | undefined {
  for (const value of [process.env.PI_COMPUTER_MODEL, process.env.PI_DEFAULT_MODEL]) {
    const env = value?.trim();
    if (env && env !== LEGACY_FLASH_MODEL_ID && !WEAK_COMPUTER_MODEL.test(env)) return env;
  }
  return undefined;
}

export function resolveOpenRouterModelId(id: string | undefined): string {
  const trimmed = id?.trim();
  if (!trimmed || trimmed === LEGACY_FLASH_MODEL_ID || WEAK_COMPUTER_MODEL.test(trimmed)) {
    return strongComputerModelFromEnv() ?? DEFAULT_OPENROUTER_MODEL_ID;
  }
  return trimmed;
}

export function resolveAuxOpenRouterModelId(id: string | undefined): string {
  const env = process.env.PI_AUX_MODEL?.trim();
  if (env) return env;
  const trimmed = id?.trim();
  if (trimmed && trimmed !== DEFAULT_OPENROUTER_MODEL_ID) return trimmed;
  return DEFAULT_AUX_MODEL_ID;
}
