export type TerminalActivityState = "failed" | "started" | "succeeded";

export interface TerminalActivityUpdate {
  readonly id: string;
  readonly label: string;
  readonly state: TerminalActivityState;
}

export interface TerminalProgressRenderer {
  close(): void;
  report(update: TerminalActivityUpdate): void;
}

export interface CreateTerminalProgressRendererOptions {
  readonly clearInterval?: (timer: ReturnType<typeof setInterval>) => void;
  readonly clock?: () => number;
  readonly interactive: boolean;
  readonly refreshIntervalMs?: number;
  readonly setInterval?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setInterval>;
  write(value: string): void;
}

export const TERMINAL_PROGRESS_REFRESH_INTERVAL_MS = 80;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CLEAR_LINE = "\r\u001b[2K";

interface ActiveTerminalActivity {
  readonly id: string;
  readonly label: string;
  readonly startedAt: number;
  frame: number;
  timer?: ReturnType<typeof setInterval>;
}

/** Renders one reusable stderr activity line without leaking timers or ANSI to stdout. */
export function createTerminalProgressRenderer(
  options: CreateTerminalProgressRendererOptions,
): TerminalProgressRenderer {
  const clock = options.clock ?? Date.now;
  const schedule = options.setInterval ?? setInterval;
  const cancel = options.clearInterval ?? clearInterval;
  const refreshIntervalMs =
    options.refreshIntervalMs ?? TERMINAL_PROGRESS_REFRESH_INTERVAL_MS;
  let active: ActiveTerminalActivity | undefined;
  let closed = false;

  const stopTimer = (activity: ActiveTerminalActivity): void => {
    if (activity.timer === undefined) return;
    cancel(activity.timer);
    delete activity.timer;
  };

  const clearActiveLine = (): void => {
    if (active === undefined) return;
    stopTimer(active);
    if (options.interactive) options.write(CLEAR_LINE);
    active = undefined;
  };

  const renderFrame = (): void => {
    if (!options.interactive || active === undefined) return;
    const frame = SPINNER_FRAMES[active.frame % SPINNER_FRAMES.length]!;
    active.frame += 1;
    options.write(
      `${CLEAR_LINE}${frame} ${active.label} (${formatElapsed(clock() - active.startedAt)})`,
    );
  };

  const start = (update: TerminalActivityUpdate): void => {
    clearActiveLine();
    const activity: ActiveTerminalActivity = {
      frame: 0,
      id: update.id,
      label: safeActivityLabel(update.label),
      startedAt: clock(),
    };
    active = activity;
    if (!options.interactive) {
      options.write(`… ${activity.label}\n`);
      return;
    }
    renderFrame();
    activity.timer = schedule(renderFrame, refreshIntervalMs);
    activity.timer.unref?.();
  };

  const finish = (update: TerminalActivityUpdate): void => {
    const matching = active?.id === update.id ? active : undefined;
    const label = matching?.label ?? safeActivityLabel(update.label);
    const elapsed = matching === undefined ? 0 : clock() - matching.startedAt;
    clearActiveLine();
    const symbol = update.state === "succeeded" ? "✓" : "✗";
    options.write(`${symbol} ${label} (${formatElapsed(elapsed)})\n`);
  };

  return {
    close() {
      if (closed) return;
      closed = true;
      clearActiveLine();
    },
    report(update) {
      if (closed) return;
      if (update.state === "started") {
        start(update);
      } else {
        finish(update);
      }
    },
  };
}

function formatElapsed(elapsedMs: number): string {
  const safeMilliseconds = Math.max(0, elapsedMs);
  if (safeMilliseconds < 60_000) {
    return `${(safeMilliseconds / 1_000).toFixed(1)}s`;
  }
  const seconds = Math.floor(safeMilliseconds / 1_000);
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function safeActivityLabel(value: string): string {
  const flattened = value
    .replace(/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return flattened.slice(0, 160) || "Working";
}
