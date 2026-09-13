/** Output streams injected into command runners; importing a runner has no side effects. */
export interface CommandIo {
  readonly stdout: { write(value: string): void };
  readonly stderr: { write(value: string): void };
}
