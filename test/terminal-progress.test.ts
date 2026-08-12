import { describe, expect, it, vi } from "vitest";

import { createTerminalProgressRenderer } from "../src/index.js";

describe("terminal progress renderer", () => {
  it("renders elapsed interactive progress and clears its timer on success", () => {
    let now = 0;
    let tick: (() => void) | undefined;
    const timer = { unref: vi.fn() } as unknown as ReturnType<
      typeof setInterval
    >;
    const cancel = vi.fn();
    const output: string[] = [];
    const renderer = createTerminalProgressRenderer({
      clearInterval: cancel,
      clock: () => now,
      interactive: true,
      refreshIntervalMs: 80,
      setInterval: (callback) => {
        tick = callback;
        return timer;
      },
      write: (value) => output.push(value),
    });

    renderer.report({ id: "sync", label: "Syncing reviews", state: "started" });
    now = 2_400;
    tick?.();
    renderer.report({
      id: "sync",
      label: "Syncing reviews",
      state: "succeeded",
    });

    expect(output.join("")).toContain("⠋ Syncing reviews (0.0s)");
    expect(output.join("")).toContain("Syncing reviews (2.4s)");
    expect(output.at(-1)).toBe("✓ Syncing reviews (2.4s)\n");
    expect(cancel).toHaveBeenCalledWith(timer);
  });

  it("cleans active output on close without reporting false success", () => {
    const output: string[] = [];
    const cancel = vi.fn();
    const renderer = createTerminalProgressRenderer({
      clearInterval: cancel,
      interactive: true,
      setInterval: () =>
        ({ unref: vi.fn() }) as unknown as ReturnType<typeof setInterval>,
      write: (value) => output.push(value),
    });

    renderer.report({
      id: "load",
      label: "Loading\u001b[31m\nitems",
      state: "started",
    });
    renderer.close();
    renderer.close();

    expect(output.join("")).toContain("Loading [31m items");
    expect(output.join("")).not.toContain("\u001b[31m");
    expect(output.join("")).not.toContain("✓");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("uses plain lines without ANSI when interactive rendering is disabled", () => {
    const output: string[] = [];
    const renderer = createTerminalProgressRenderer({
      clock: () => 1_000,
      interactive: false,
      write: (value) => output.push(value),
    });

    renderer.report({
      id: "doctor",
      label: "Checking health",
      state: "started",
    });
    renderer.report({
      id: "doctor",
      label: "Checking health",
      state: "failed",
    });

    expect(output.join("")).toBe(
      "… Checking health\n✗ Checking health (0.0s)\n",
    );
    expect(output.join("")).not.toContain("\u001b");
  });
});
