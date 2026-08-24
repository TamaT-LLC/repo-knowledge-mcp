export type DoctorCheckStatus = "fail" | "pass" | "warn";

export interface DoctorCheck {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly id: string;
  readonly message: string;
  readonly path?: string;
  readonly remedy?: string;
  readonly status: DoctorCheckStatus;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  readonly ok: boolean;
  readonly summary: {
    readonly fail: number;
    readonly pass: number;
    readonly warn: number;
  };
}

export class DoctorReportBuilder {
  private readonly checks: DoctorCheck[] = [];

  add(check: DoctorCheck): void {
    this.checks.push(check);
  }

  build(): DoctorReport {
    const summary = { fail: 0, pass: 0, warn: 0 };
    for (const check of this.checks) summary[check.status] += 1;
    return {
      checks: [...this.checks],
      ok: summary.fail === 0,
      summary,
    };
  }
}
