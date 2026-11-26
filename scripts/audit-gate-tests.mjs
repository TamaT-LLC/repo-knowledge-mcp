import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AUDIT_ALLOWLIST,
  AuditGateError,
  auditGateResult,
  collectBlockingAdvisories,
  evaluateAuditReport,
  parseAuditOutput,
} from "./audit-gate.mjs";

const PICOMATCH_ADVISORY = Object.freeze({
  source: 1247710,
  name: "picomatch",
  dependency: "picomatch",
  title:
    "picomatch vulnerable to ReDoS through single-branch repeated extglobs",
  url: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf",
  severity: "high",
  cwe: ["CWE-1333"],
  range: "<=4.0.7",
});

/** Mirrors the shape of `npm audit --json` (auditReportVersion 2). */
function auditReport(vulnerabilities) {
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: { vulnerabilities: {} },
  };
}

function vulnerability(name, severity, via) {
  return { name, severity, isDirect: false, via, effects: [], range: "*" };
}

function advisory(overrides) {
  return { ...PICOMATCH_ADVISORY, ...overrides };
}

/** Allowlist fixture; the gate's real allowlist can be empty. */
const PICOMATCH_ALLOWLIST = Object.freeze([
  Object.freeze({
    id: "GHSA-fc5q-39xc-vjpf",
    package: "picomatch",
    reason: "test fixture",
    removeWhen: "test fixture",
  }),
]);

const PICOMATCH_ONLY_REPORT = auditReport({
  fdir: vulnerability("fdir", "high", ["picomatch"]),
  picomatch: vulnerability("picomatch", "high", [PICOMATCH_ADVISORY]),
  tinyglobby: vulnerability("tinyglobby", "high", ["fdir", "picomatch"]),
  vite: vulnerability("vite", "high", ["picomatch", "tinyglobby"]),
});

test("allowlist entries document a reason and a removal condition", () => {
  for (const entry of [...AUDIT_ALLOWLIST, ...PICOMATCH_ALLOWLIST]) {
    assert.match(entry.id, /^GHSA(?:-[0-9a-z]{4}){3}$/u);
    assert.ok(entry.reason.length > 0, `${entry.id} needs a reason`);
    assert.ok(entry.removeWhen.length > 0, `${entry.id} needs removeWhen`);
  }
});

test("collects only advisory objects and ignores package references", () => {
  assert.deepEqual(collectBlockingAdvisories(PICOMATCH_ONLY_REPORT), [
    {
      id: "GHSA-fc5q-39xc-vjpf",
      packages: ["picomatch"],
      severity: "high",
      title: PICOMATCH_ADVISORY.title,
      url: PICOMATCH_ADVISORY.url,
    },
  ]);
});

test("passes when the only high advisory is allowlisted", () => {
  assert.deepEqual(
    evaluateAuditReport(PICOMATCH_ONLY_REPORT, PICOMATCH_ALLOWLIST),
    {
      allowed: collectBlockingAdvisories(PICOMATCH_ONLY_REPORT),
      blocking: [],
      staleAllowlistIds: [],
    },
  );
  const result = auditGateResult(
    JSON.stringify(PICOMATCH_ONLY_REPORT),
    PICOMATCH_ALLOWLIST,
  );
  assert.equal(result.exitCode, 0);
  assert.ok(result.messages.every((message) => message.level === "info"));
});

test("fails on a high or critical advisory missing from the allowlist", () => {
  for (const severity of ["high", "critical"]) {
    const report = auditReport({
      ...PICOMATCH_ONLY_REPORT.vulnerabilities,
      "other-package": vulnerability("other-package", severity, [
        advisory({
          name: "other-package",
          severity,
          source: 1,
          title: "Other issue",
          url: "https://github.com/advisories/GHSA-2222-3333-4444",
        }),
      ]),
    });

    const evaluation = evaluateAuditReport(report, PICOMATCH_ALLOWLIST);
    assert.deepEqual(
      evaluation.blocking.map((entry) => [entry.id, entry.severity]),
      [["GHSA-2222-3333-4444", severity]],
    );
    const result = auditGateResult(JSON.stringify(report), PICOMATCH_ALLOWLIST);
    assert.equal(result.exitCode, 1);
    assert.ok(
      result.messages.some(
        (message) =>
          message.level === "error" &&
          message.text.includes("GHSA-2222-3333-4444"),
      ),
    );
  }
});

test("ignores low and moderate advisories", () => {
  const report = auditReport({
    lodash: vulnerability("lodash", "moderate", [
      advisory({
        name: "lodash",
        severity: "moderate",
        source: 2,
        url: "https://github.com/advisories/GHSA-5555-6666-7777",
      }),
      advisory({
        name: "lodash",
        severity: "low",
        source: 3,
        url: "https://github.com/advisories/GHSA-8888-9999-aaaa",
      }),
    ]),
  });

  assert.deepEqual(collectBlockingAdvisories(report), []);
});

test("treats an unknown advisory severity as blocking", () => {
  const report = auditReport({
    left: vulnerability("left", "high", [
      advisory({
        name: "left",
        severity: "severe",
        source: 4,
        url: "https://github.com/advisories/GHSA-bbbb-cccc-dddd",
      }),
    ]),
  });

  assert.deepEqual(
    evaluateAuditReport(report, []).blocking.map((entry) => entry.id),
    ["GHSA-bbbb-cccc-dddd"],
  );
});

test("merges a repeated advisory across packages by GHSA ID", () => {
  const report = auditReport({
    "node_modules/a/node_modules/picomatch": vulnerability(
      "picomatch",
      "high",
      [PICOMATCH_ADVISORY],
    ),
    picomatch: vulnerability("picomatch", "high", [
      advisory({ source: 1247711 }),
    ]),
  });

  assert.deepEqual(
    collectBlockingAdvisories(report).map((entry) => entry.id),
    ["GHSA-fc5q-39xc-vjpf"],
  );
});

test("falls back to the npm source ID when the URL has no GHSA ID", () => {
  const report = auditReport({
    legacy: vulnerability("legacy", "critical", [
      advisory({
        name: "legacy",
        severity: "critical",
        source: 1179,
        url: "https://npmjs.com/advisories/1179",
      }),
    ]),
  });

  const result = auditGateResult(JSON.stringify(report));
  assert.equal(result.exitCode, 1);
  assert.ok(
    result.messages.some((message) =>
      message.text.includes("npm-advisory-1179"),
    ),
  );
});

test("warns without failing when an allowlisted advisory disappears", () => {
  const result = auditGateResult(
    JSON.stringify(auditReport({})),
    PICOMATCH_ALLOWLIST,
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(
    result.messages
      .filter((message) => message.level === "warning")
      .map((message) => message.text.split(" ")[2]),
    ["GHSA-fc5q-39xc-vjpf"],
  );
  assert.deepEqual(
    evaluateAuditReport(auditReport({}), PICOMATCH_ALLOWLIST).staleAllowlistIds,
    ["GHSA-fc5q-39xc-vjpf"],
  );
});

test("fails when npm audit itself reports an error", () => {
  const stdout = JSON.stringify({
    error: {
      code: "ENOLOCK",
      summary: "This command requires an existing lockfile.",
      detail: "Try creating one first with: npm i --package-lock-only",
    },
  });

  assert.throws(() => parseAuditOutput(stdout), AuditGateError);
  const result = auditGateResult(stdout);
  assert.equal(result.exitCode, 1);
  assert.match(result.messages[0]?.text ?? "", /npm audit failed: ENOLOCK/u);
});

test("fails on via items that are neither package names nor advisories", () => {
  const { source: _source, ...withoutSource } = PICOMATCH_ADVISORY;
  const { severity: _severity, ...withoutSeverity } = PICOMATCH_ADVISORY;
  const { url: _url, ...withoutUrl } = PICOMATCH_ADVISORY;
  for (const via of [
    { severity: "high", url: "advisory" },
    withoutSource,
    withoutSeverity,
    withoutUrl,
    advisory({ source: null }),
    42,
    null,
    true,
    ["picomatch"],
  ]) {
    const report = auditReport({
      fdir: vulnerability("fdir", "high", ["picomatch"]),
      picomatch: vulnerability("picomatch", "high", [PICOMATCH_ADVISORY, via]),
    });
    const label = JSON.stringify(via);

    assert.throws(
      () => collectBlockingAdvisories(report),
      AuditGateError,
      label,
    );
    const result = auditGateResult(JSON.stringify(report));
    assert.equal(result.exitCode, 1, label);
    assert.match(
      result.messages[0]?.text ?? "",
      /picomatch has a malformed via item/u,
      label,
    );
  }
});

test("fails on empty, malformed, or unsupported npm audit output", () => {
  for (const stdout of [
    "",
    "not json",
    "[]",
    JSON.stringify({ auditReportVersion: 2 }),
    JSON.stringify(auditReport({ broken: { name: "broken" } })),
  ]) {
    const result = auditGateResult(stdout);
    assert.equal(result.exitCode, 1, stdout);
    assert.equal(result.messages[0]?.level, "error", stdout);
  }
});
