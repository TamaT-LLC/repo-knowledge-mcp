/* global URL */

import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Advisory severities that fail the gate unless allowlisted. */
export const BLOCKING_SEVERITIES = Object.freeze(["high", "critical"]);

const KNOWN_SEVERITIES = new Set([
  "info",
  "low",
  "moderate",
  "high",
  "critical",
]);

/**
 * Reviewed high/critical advisories that may stay in the dependency graph.
 *
 * Every entry needs a reason and an exit condition. Remove the entry as soon as
 * its exit condition holds; the gate warns once the advisory no longer appears
 * in `npm audit` output.
 */
export const AUDIT_ALLOWLIST = Object.freeze([
  Object.freeze({
    id: "GHSA-fc5q-39xc-vjpf",
    package: "picomatch",
    reason:
      "picomatch <= 4.0.7 has a ReDoS in single-branch repeated extglobs and " +
      "no fixed release exists yet. Runtime scope matching compiles every " +
      "glob with noextglob (src/scope-glob.ts), so extglob semantics are off " +
      "and the vulnerable extglob path is not reachable from repository " +
      "scopes. The remaining paths are dev-only (vitest, vite, tinyglobby, " +
      "fdir) and only see globs from this repository's own configuration.",
    removeWhen:
      "Remove this entry once picomatch publishes a fixed release and the " +
      "lockfile resolves every picomatch copy to it.",
  }),
]);

export class AuditGateError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "AuditGateError";
  }
}

/** Parses `npm audit --json` stdout and rejects npm audit's own failures. */
export function parseAuditOutput(stdout) {
  if (typeof stdout !== "string" || stdout.trim() === "") {
    throw new AuditGateError("npm audit produced no JSON output");
  }
  let report;
  try {
    report = JSON.parse(stdout);
  } catch (error) {
    throw new AuditGateError("npm audit output is not valid JSON", {
      cause: error,
    });
  }
  return validateAuditReport(report);
}

/** Validates a parsed `npm audit --json` document. */
export function validateAuditReport(report) {
  if (!isRecord(report)) {
    throw new AuditGateError("npm audit report must be a JSON object");
  }
  if (report.error !== undefined && report.error !== null) {
    throw new AuditGateError(
      `npm audit failed: ${describeError(report.error)}`,
    );
  }
  if (!isRecord(report.vulnerabilities)) {
    throw new AuditGateError(
      "npm audit report has no vulnerabilities object; unsupported format",
    );
  }
  return report;
}

/**
 * Collects high/critical advisories from `vulnerabilities[*].via`.
 *
 * String `via` entries only point at another vulnerable package, so only
 * advisory objects are read. Advisories with an unknown severity are treated
 * as blocking, and repeated advisories are merged by ID.
 */
export function collectBlockingAdvisories(report) {
  const advisories = new Map();
  for (const [packageName, vulnerability] of Object.entries(
    validateAuditReport(report).vulnerabilities,
  )) {
    if (!isRecord(vulnerability) || !Array.isArray(vulnerability.via)) {
      throw new AuditGateError(
        `npm audit entry for ${packageName} has no via list`,
      );
    }
    for (const via of vulnerability.via) {
      if (!isAdvisory(via)) continue;
      const severity = String(via.severity);
      if (
        KNOWN_SEVERITIES.has(severity) &&
        !BLOCKING_SEVERITIES.includes(severity)
      ) {
        continue;
      }
      const id = advisoryId(via);
      const existing = advisories.get(id);
      if (existing === undefined) {
        advisories.set(id, {
          id,
          packages: [String(via.name ?? packageName)],
          severity,
          title: typeof via.title === "string" ? via.title : "",
          url: String(via.url),
        });
      } else {
        const name = String(via.name ?? packageName);
        if (!existing.packages.includes(name)) existing.packages.push(name);
      }
    }
  }
  return [...advisories.values()]
    .map((advisory) => ({ ...advisory, packages: advisory.packages.sort() }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

/** Splits blocking advisories into allowed and failing sets. */
export function evaluateAuditReport(report, allowlist = AUDIT_ALLOWLIST) {
  const allowedIds = new Set(allowlist.map((entry) => entry.id));
  const advisories = collectBlockingAdvisories(report);
  const presentIds = new Set(advisories.map((advisory) => advisory.id));
  return {
    allowed: advisories.filter((advisory) => allowedIds.has(advisory.id)),
    blocking: advisories.filter((advisory) => !allowedIds.has(advisory.id)),
    staleAllowlistIds: allowlist
      .map((entry) => entry.id)
      .filter((id) => !presentIds.has(id)),
  };
}

/** Turns raw `npm audit --json` stdout into an exit code and messages. */
export function auditGateResult(stdout, allowlist = AUDIT_ALLOWLIST) {
  let evaluation;
  try {
    evaluation = evaluateAuditReport(parseAuditOutput(stdout), allowlist);
  } catch (error) {
    if (!(error instanceof AuditGateError)) throw error;
    return { exitCode: 1, messages: [{ level: "error", text: error.message }] };
  }
  const messages = [];
  for (const advisory of evaluation.allowed) {
    messages.push({
      level: "info",
      text: `allowlisted ${formatAdvisory(advisory)}`,
    });
  }
  for (const id of evaluation.staleAllowlistIds) {
    messages.push({
      level: "warning",
      text: `allowlisted advisory ${id} no longer appears in npm audit; remove it from AUDIT_ALLOWLIST in scripts/audit-gate.mjs`,
    });
  }
  for (const advisory of evaluation.blocking) {
    messages.push({
      level: "error",
      text: `unreviewed ${formatAdvisory(advisory)}`,
    });
  }
  if (evaluation.blocking.length > 0) {
    return { exitCode: 1, messages };
  }
  messages.push({
    level: "info",
    text: `npm audit gate passed: ${evaluation.allowed.length} allowlisted, 0 unreviewed ${BLOCKING_SEVERITIES.join("/")} advisories`,
  });
  return { exitCode: 0, messages };
}

function advisoryId(advisory) {
  const match = /GHSA(?:-[0-9a-z]{4}){3}/u.exec(String(advisory.url));
  return match?.[0] ?? `npm-advisory-${String(advisory.source)}`;
}

function formatAdvisory(advisory) {
  return `${advisory.severity} advisory ${advisory.id} in ${advisory.packages.join(", ")}: ${advisory.title} (${advisory.url})`;
}

function isAdvisory(value) {
  return (
    isRecord(value) &&
    value.url !== undefined &&
    value.severity !== undefined &&
    value.source !== undefined
  );
}

function describeError(error) {
  if (!isRecord(error)) return String(error);
  return [error.code, error.summary, error.detail]
    .filter((part) => typeof part === "string" && part !== "")
    .join(": ");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runNpmAudit() {
  // Reuse the npm that launched `npm run audit:gate` instead of resolving
  // another one from PATH.
  const npmCli = process.env.npm_execpath;
  const [command, args] = npmCli?.endsWith(".js")
    ? [process.execPath, [npmCli, "audit", "--json"]]
    : ["npm", ["audit", "--json"]];
  return new Promise((resolvePromise, reject) => {
    execFile(
      command,
      args,
      { cwd: repositoryRoot, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        // npm audit exits non-zero whenever it finds vulnerabilities, so the
        // JSON body, not the exit code, decides the result.
        if (error !== null && stdout === "") {
          reject(new AuditGateError("npm audit did not run", { cause: error }));
          return;
        }
        resolvePromise(stdout);
      },
    );
  });
}

async function run() {
  const result = auditGateResult(await runNpmAudit());
  const annotate = process.env.GITHUB_ACTIONS === "true";
  for (const { level, text } of result.messages) {
    if (level === "info") {
      process.stdout.write(`${text}\n`);
    } else if (annotate) {
      process.stderr.write(`::${level} title=audit-gate::${text}\n`);
    } else {
      process.stderr.write(`${level}: ${text}\n`);
    }
  }
  process.exitCode = result.exitCode;
}

function isMainModule() {
  return (
    process.argv[1] !== undefined &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  );
}

if (isMainModule()) {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
