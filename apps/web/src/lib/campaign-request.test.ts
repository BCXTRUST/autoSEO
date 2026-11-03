import { describe, expect, it } from "vitest";
import { CampaignRequestGate } from "./campaign-request";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("campaign request gate", () => {
  it("aborts a hung request when navigation switches campaigns and runs the new route immediately", async () => {
    const gate = new CampaignRequestGate();
    const oldSignal = gate.activate("campaign-old");
    const oldRequest = gate.run(
      "campaign-old",
      oldSignal,
      (signal) =>
        new Promise<void>((_, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    await Promise.resolve();

    const newSignal = gate.activate("campaign-new");
    let loadedNewRoute = false;
    await gate.run("campaign-new", newSignal, async () => {
      loadedNewRoute = true;
    });

    expect(oldSignal.aborted).toBe(true);
    expect(loadedNewRoute).toBe(true);
    await expect(oldRequest).rejects.toMatchObject({ name: "AbortError" });
  });

  it("queues a mutation refresh behind an in-flight poll without overlapping requests", async () => {
    const gate = new CampaignRequestGate();
    const signal = gate.activate("campaign-1");
    const first = deferred();
    let running = 0;
    let maxRunning = 0;
    let mutationRan = false;
    const poll = gate.run("campaign-1", signal, async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await first.promise;
      running--;
    });
    const mutationRefresh = gate.run("campaign-1", signal, async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      mutationRan = true;
      running--;
    });

    await Promise.resolve();
    expect(mutationRan).toBe(false);
    first.resolve();
    await Promise.all([poll, mutationRefresh]);

    expect(mutationRan).toBe(true);
    expect(maxRunning).toBe(1);
  });
});
