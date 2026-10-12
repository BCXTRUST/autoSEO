export interface PersonaComputerRef {
  scope: string;
  state: string;
  providerRef: string | null;
}

/**
 * The persona browser and the operator screen share one machine. A running team computer
 * wins. A running dedicated computer is used when the workspace never started a team one.
 * A suspended or stopped machine with a provider ref is still chosen so the caller can wake it.
 * A team machine whose desktop was destroyed is still chosen so the caller can create one.
 */
export function choosePersonaComputer<T extends PersonaComputerRef>(rows: readonly T[]): T | null {
  const withRef = rows.filter((row) => Boolean(row.providerRef));
  const awake = withRef.filter((row) => row.state === "running" || row.state === "booting");
  const asleep = withRef.filter((row) => row.state === "suspended" || row.state === "stopped");
  const bare = rows.filter((row) => !row.providerRef);
  const pick = (list: readonly T[]) => list.find((row) => row.scope === "team") ?? list[0] ?? null;
  return pick(awake) ?? pick(asleep) ?? pick(bare);
}
