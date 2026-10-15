import { Sandbox, SandboxNotFoundError } from "e2b";

export interface E2BFleetComputer {
  id: string;
  state: "running" | "paused";
  startedAt: Date;
  template: string;
}

export interface E2BFleetSandboxInfo {
  sandboxId: string;
  state: string;
  startedAt: Date;
  templateId: string;
  name?: string;
}

export interface E2BFleetPaginator {
  hasNext: boolean;
  nextItems(): Promise<E2BFleetSandboxInfo[]>;
}

export interface E2BFleetSdk {
  list(opts: {
    apiKey: string;
    query: { metadata: { rakazo: "computer" }; state: Array<"running" | "paused"> };
  }): AsyncIterable<E2BFleetSandboxInfo[]> | E2BFleetPaginator;
  getInfo(id: string, opts: { apiKey: string }): Promise<E2BFleetSandboxInfo>;
  kill(id: string, opts: { apiKey: string }): Promise<boolean>;
}

export interface E2BFleet {
  listComputers(): Promise<E2BFleetComputer[]>;
  info(id: string): Promise<E2BFleetComputer | null>;
  kill(id: string): Promise<boolean>;
}

function defaultSdk(): E2BFleetSdk {
  return {
    list: (opts) => Sandbox.list(opts),
    getInfo: (id, opts) => Sandbox.getInfo(id, opts),
    kill: (id, opts) => Sandbox.kill(id, opts),
  };
}

function isNotFound(error: unknown): boolean {
  if (error instanceof SandboxNotFoundError) return true;
  const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
  if (name === "SandboxNotFoundError" || name === "NotFoundError") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /not found|does not exist|404/i.test(message);
}

function toComputer(info: E2BFleetSandboxInfo): E2BFleetComputer {
  const state = info.state === "paused" ? "paused" : "running";
  return {
    id: info.sandboxId,
    state,
    startedAt: info.startedAt,
    template: info.name ?? info.templateId,
  };
}

function isPaginator(
  pages: AsyncIterable<E2BFleetSandboxInfo[]> | E2BFleetPaginator,
): pages is E2BFleetPaginator {
  return typeof (pages as E2BFleetPaginator).nextItems === "function";
}

export function createE2BFleet(apiKey: string, sdk: E2BFleetSdk = defaultSdk()): E2BFleet {
  return {
    async listComputers() {
      const pages = sdk.list({
        apiKey,
        query: { metadata: { rakazo: "computer" }, state: ["running", "paused"] },
      });
      const computers: E2BFleetComputer[] = [];
      if (isPaginator(pages)) {
        while (pages.hasNext) {
          const page = await pages.nextItems();
          computers.push(...page.map(toComputer));
        }
        return computers;
      }
      for await (const page of pages) {
        computers.push(...page.map(toComputer));
      }
      return computers;
    },
    async info(id) {
      try {
        return toComputer(await sdk.getInfo(id, { apiKey }));
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async kill(id) {
      try {
        return await sdk.kill(id, { apiKey });
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
    },
  };
}
