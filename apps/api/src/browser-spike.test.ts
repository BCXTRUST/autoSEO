import { describe, expect, it } from "vitest";
import {
  chromiumWindowAtOrigin,
  evaluateSpike,
  ppmMean,
  type SpikeSandbox,
} from "./browser-spike.js";

function ppm(pixels: number[]): Uint8Array {
  const body = Buffer.from(pixels);
  const header = Buffer.from("P6\n1 1\n255\n");
  return Buffer.concat([header, body]);
}

describe("browser spike checks", () => {
  it("accepts a Chromium window at 0,0 and a non-black sample", () => {
    expect(chromiumWindowAtOrigin('0x1 "Example - Chromium": ("chromium") 1280x800+0+0')).toBe(
      true,
    );
    expect(
      chromiumWindowAtOrigin(
        '0x200003 "Example Domain - Google Chrome for Testing": ("chromium-browser (/home/user/.browser-profiles/spike)" "Chromium-browser")  1279x799+0+0  +0+0',
      ),
    ).toBe(true);
    expect(chromiumWindowAtOrigin("1280x800+10+0 chromium")).toBe(false);
    expect(chromiumWindowAtOrigin("1288x991+10+10")).toBe(false);
    expect(ppmMean(ppm([20, 20, 20]))).toBe(20);
    expect(ppmMean(ppm([0, 0, 0]))).toBe(0);
  });

  it("kills the sandbox after the checks", async () => {
    let killed = false;
    const commands: string[] = [];
    const sandbox: SpikeSandbox = {
      streamHost: "6080-box.e2b.app",
      async run(command) {
        commands.push(command);
        if (command.includes("xwininfo")) {
          return {
            stdout: '0x1 "Example - Chromium": ("chromium") 1280x800+0+0',
            exitCode: 0,
          };
        }
        if (command.includes("xfce4-session")) return { stdout: "", exitCode: 1 };
        if (command.includes("http_code")) return { stdout: "200", exitCode: 0 };
        if (command.includes("pgrep -x sleep")) return { stdout: "4242\n", exitCode: 0 };
        return { stdout: "", exitCode: 0 };
      },
      async readFile() {
        return ppm([30, 30, 30]);
      },
      async ensureRunner() {
        commands.push("runner");
      },
      async openExample() {
        commands.push("https://example.org/");
      },
      async kill() {
        killed = true;
      },
    };
    const result = await evaluateSpike(sandbox, async () => undefined);
    expect(result.checks).toEqual({
      setsid: true,
      window: true,
      noXfce: true,
      notBlack: true,
      novnc: true,
    });
    expect(result.streamHost).toBe("6080-box.e2b.app");
    expect(commands[0]).toBe("runner");
    expect(commands).toContain("https://example.org/");
    expect(killed).toBe(true);
  });

  it("checks the window while the browser session is still open", async () => {
    const order: string[] = [];
    const closed = false;
    const sandbox: SpikeSandbox = {
      streamHost: "6080-box.e2b.app",
      async run(command) {
        order.push(command);
        if (command.includes("xwininfo")) {
          return { stdout: '0x1 ("chromium") 1280x800+0+0', exitCode: 0 };
        }
        if (command.includes("pgrep -x sleep")) return { stdout: "9\n", exitCode: 0 };
        if (command.includes("http_code")) return { stdout: "200", exitCode: 0 };
        return { stdout: "", exitCode: 0 };
      },
      async readFile() {
        return ppm([30, 30, 30]);
      },
      async ensureRunner() {
        order.push("runner");
      },
      async openExample() {
        order.push("open");
      },
      async kill() {
        order.push("kill");
        expect(closed).toBe(false);
      },
    };
    await evaluateSpike(sandbox, async () => undefined);
    const detach = order.find((entry) => entry.startsWith("setsid"));
    expect(detach).toContain("</dev/null >/dev/null 2>&1");
    expect(order.indexOf("open")).toBeLessThan(
      order.findIndex((entry) => entry.includes("xwininfo")),
    );
    expect(order.at(-1)).toBe("kill");
    expect(order).not.toContain("close");
    expect(closed).toBe(false);
  });
});
