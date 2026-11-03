// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "./AppErrorBoundary";

const roots: ReturnType<typeof createRoot>[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
});

describe("AppErrorBoundary recovery", () => {
  it("catches a render failure and offers safe recovery actions", async () => {
    const mount = document.createElement("div");
    document.body.append(mount);
    const root = createRoot(mount);
    roots.push(root);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    function BrokenPage(): ReactNode {
      throw new Error("private implementation detail");
    }

    try {
      await act(async () => {
        root.render(
          <AppErrorBoundary>
            <BrokenPage />
          </AppErrorBoundary>,
        );
      });

      expect(mount.querySelector("h1")?.textContent).toBe("This page hit a snag");
      expect(mount.querySelector("button")?.textContent).toBe("Reload page");
      expect(mount.querySelector('a[href="/app"]')?.textContent).toBe("Back to campaigns");
      expect(mount.textContent).not.toContain("private implementation detail");
    } finally {
      consoleError.mockRestore();
      mount.remove();
    }
  });
});
