import { Sandbox as DesktopSandbox } from "@e2b/desktop";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { E2BSandboxProvider, ensureBrowserRunner } from "@rakazo/adapters";
import { SandboxBrowserSessionFactory } from "@rakazo/linkbuilder-browser";
import { Sandbox as E2BSandbox } from "e2b";

export interface SpikeChecks {
  setsid: boolean;
  window: boolean;
  noXfce: boolean;
  notBlack: boolean;
  novnc: boolean;
}

export interface SpikeResult {
  checks: SpikeChecks;
  streamHost: string;
}

const SPIKE_PERSONA = {
  projectId: "spike",
  profileKey: "spike",
  locale: "de-DE" as const,
  timezoneId: "Europe/Berlin",
};

const SPIKE_CONTEXT: AdapterContext = {
  operationId: "browser-spike",
  traceId: "browser-spike",
  workspaceId: "spike",
  userId: "spike",
  signal: new AbortController().signal,
};

export function chromiumWindowAtOrigin(tree: string): boolean {
  return tree.split("\n").some((line) => {
    if (!/chromium/i.test(line)) return false;
    const size = line.match(/(\d+)x(\d+)\+0\+0/);
    if (!size) return false;
    return Number(size[1]) >= 1270 && Number(size[2]) >= 790;
  });
}

export function ppmMean(bytes: Uint8Array): number | null {
  const header = Buffer.from(bytes).toString("latin1");
  if (!header.startsWith("P6")) return null;
  let index = 2;
  const tokens: string[] = [];
  while (index < bytes.length && tokens.length < 3) {
    while (
      index < bytes.length &&
      (bytes[index] === 32 || bytes[index] === 10 || bytes[index] === 13 || bytes[index] === 9)
    ) {
      index += 1;
    }
    if (bytes[index] === 35) {
      while (index < bytes.length && bytes[index] !== 10) index += 1;
      continue;
    }
    const start = index;
    while (index < bytes.length && bytes[index]! > 32) index += 1;
    tokens.push(Buffer.from(bytes.subarray(start, index)).toString("latin1"));
  }
  const width = Number(tokens[0]);
  const height = Number(tokens[1]);
  const max = Number(tokens[2]);
  if (!width || !height || !max) return null;
  if (bytes[index] === 10 || bytes[index] === 13 || bytes[index] === 32) index += 1;
  const samples = width * height * 3;
  if (bytes.length < index + samples) return null;
  let total = 0;
  for (let offset = 0; offset < samples; offset += 1) total += bytes[index + offset] ?? 0;
  return total / samples;
}

interface SpikeCommand {
  stdout: string;
  bytes?: Uint8Array;
  exitCode: number;
}

export interface SpikeSandbox {
  streamHost: string;
  run(command: string): Promise<SpikeCommand>;
  readFile(path: string): Promise<Uint8Array>;
  ensureRunner(): Promise<void>;
  openExample(): Promise<void>;
  kill(): Promise<void>;
}

export async function evaluateSpike(
  sandbox: SpikeSandbox,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<SpikeResult> {
  try {
    await sandbox.ensureRunner();
    await sandbox.openExample();
    await sandbox.run("setsid -f sleep 600");
    await sleep(30_000);
    const alive = await sandbox.run("pgrep -f 'sleep 600'").catch(() => ({
      stdout: "",
      exitCode: 1,
    }));
    const tree = await sandbox.run("DISPLAY=:0 xwininfo -root -tree").catch(() => ({
      stdout: "",
      exitCode: 1,
    }));
    const xfce = await sandbox.run("pgrep -x xfce4-session").catch(() => ({
      stdout: "",
      exitCode: 1,
    }));
    await sandbox
      .run("DISPLAY=:0 import -window root -crop 16x16+632+392 /tmp/autoseo-spike.ppm")
      .catch(() => undefined);
    const ppm = await sandbox.readFile("/tmp/autoseo-spike.ppm").catch(() => new Uint8Array());
    const mean = ppmMean(ppm);
    const novnc = await sandbox
      .run("curl -sf -o /dev/null -w '%{http_code}' http://localhost:6080/vnc.html")
      .catch(() => ({ stdout: "", exitCode: 1 }));
    return {
      streamHost: sandbox.streamHost,
      checks: {
        setsid: alive.stdout.trim().length > 0,
        window: chromiumWindowAtOrigin(tree.stdout),
        noXfce: xfce.stdout.trim().length === 0,
        notBlack: mean !== null && mean > 12,
        novnc: novnc.stdout.trim() === "200",
      },
    };
  } finally {
    await sandbox.kill();
  }
}

export async function runBrowserSpike(env: NodeJS.ProcessEnv = process.env): Promise<SpikeResult> {
  const apiKey = env.E2B_API_KEY?.trim();
  if (!apiKey) throw new Error("E2B_API_KEY is unset");
  const created = await E2BSandbox.create("autoseo-browser-v1", {
    apiKey,
    timeoutMs: 300_000,
    metadata: { rakazo: "computer", spike: "1" },
    lifecycle: { onTimeout: "kill" },
  });
  const desktop = await DesktopSandbox.connect(created.sandboxId, {
    apiKey,
    timeoutMs: 300_000,
  });
  const streamHost =
    typeof desktop.getHost === "function"
      ? desktop.getHost(6080)
      : `6080-${created.sandboxId}.${env.E2B_DOMAIN?.trim() || "e2b.app"}`;
  const provider = new E2BSandboxProvider(apiKey);
  const factory = new SandboxBrowserSessionFactory({
    sandbox: provider,
    runnerArgv: ["/home/user/.autoseo/bin/rakazo-lb-browser"],
    bundledChromium: true,
    kiosk: true,
    profileRoot: "/home/user/.browser-profiles",
    headless: false,
    resolveComputer: async () => ({
      id: created.sandboxId,
      botId: "spike",
      kind: "e2b",
      providerRef: created.sandboxId,
    }),
  });
  return evaluateSpike({
    streamHost,
    async run(command) {
      const result = await desktop.commands.run(command, { timeoutMs: 30_000 });
      return {
        stdout: typeof result.stdout === "string" ? result.stdout : "",
        exitCode: result.exitCode ?? 0,
      };
    },
    async readFile(path) {
      const value = await desktop.files.read(path);
      return typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
    },
    async ensureRunner() {
      await ensureBrowserRunner(desktop);
    },
    async openExample() {
      try {
        const session = await factory.open(SPIKE_PERSONA, SPIKE_CONTEXT);
        try {
          await session.goto("https://example.org/");
        } finally {
          await session.close().catch(() => undefined);
        }
      } catch (error) {
        const log = await desktop.commands
          .run("tail -n 40 /tmp/rakazo-lb/spike.json.log", { timeoutMs: 30_000 })
          .catch(() => ({ stdout: "" }));
        const text = typeof log.stdout === "string" ? log.stdout : "";
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message}\nrunner log:\n${text}`);
      }
    },
    async kill() {
      await E2BSandbox.kill(created.sandboxId, { apiKey }).catch(() => undefined);
    },
  });
}
