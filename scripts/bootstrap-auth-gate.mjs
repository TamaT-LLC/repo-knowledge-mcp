/* global URL, process */

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BOOTSTRAP_AUTH_REPORT_KIND =
  "repo_knowledge_npm_bootstrap_auth_gate";
export const BOOTSTRAP_AUTH_REPORT_SCHEMA_VERSION = 1;
export const BOOTSTRAP_RELEASE_TAG = "v0.3.0";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function validateBootstrapAuth(input) {
  const failures = [];
  const bootstrap = input.tag === BOOTSTRAP_RELEASE_TAG;

  if (bootstrap) {
    check(
      input.tokenPresent,
      "bootstrap token is required for v0.3.0",
      failures,
    );
    if (input.tokenPresent) {
      const expectedOwnerValid =
        typeof input.expectedOwner === "string" &&
        input.expectedOwner.trim() === input.expectedOwner &&
        input.expectedOwner.length > 0;
      check(
        expectedOwnerValid,
        "NPM_PACKAGE_OWNER is required for bootstrap",
        failures,
      );
      if (expectedOwnerValid) {
        check(
          input.observedOwner === input.expectedOwner,
          "bootstrap token owner does not match NPM_PACKAGE_OWNER",
          failures,
        );
      }
    }
  } else {
    check(
      !input.tokenPresent,
      `bootstrap token is restricted to ${BOOTSTRAP_RELEASE_TAG}`,
      failures,
    );
  }

  return {
    authentication_mode: bootstrap ? "bootstrap" : "trusted_publishing",
    failures,
    owner:
      bootstrap && input.observedOwner === input.expectedOwner
        ? input.expectedOwner
        : null,
    report_kind: BOOTSTRAP_AUTH_REPORT_KIND,
    schema_version: BOOTSTRAP_AUTH_REPORT_SCHEMA_VERSION,
    status: failures.length === 0 ? "pass" : "fail",
    tag: input.tag,
    token_present: input.tokenPresent,
  };
}

async function inspectBootstrapAuth(options) {
  const tokenPresent =
    typeof process.env.NODE_AUTH_TOKEN === "string" &&
    process.env.NODE_AUTH_TOKEN.length > 0;
  const observedOwner =
    tokenPresent && options.tag === BOOTSTRAP_RELEASE_TAG
      ? (
          await runNpm(
            ["whoami", "--registry=https://registry.npmjs.org/"],
            options.cwd,
          )
        ).stdout.trim()
      : null;
  return validateBootstrapAuth({
    expectedOwner: options.expectedOwner,
    observedOwner,
    tag: options.tag,
    tokenPresent,
  });
}

function parseArguments(argv) {
  const options = { cwd: repositoryRoot };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--tag" && value !== undefined) {
      options.tag = value;
      index += 1;
    } else if (argument === "--expected-owner" && value !== undefined) {
      options.expectedOwner = value;
      index += 1;
    } else if (argument === "--report" && value !== undefined) {
      options.reportPath = resolve(value);
      index += 1;
    } else {
      throw new Error(`unknown or incomplete argument ${String(argument)}`);
    }
  }
  if (options.tag === undefined || options.expectedOwner === undefined) {
    throw new Error("--tag and --expected-owner are required");
  }
  return options;
}

function runNpm(args, cwd) {
  const npmExecPath = process.env.npm_execpath;
  return npmExecPath === undefined
    ? run("npm", args, cwd)
    : run(process.execPath, [npmExecPath, ...args], cwd);
}

function run(command, args, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolvePromise({ stderr, stdout });
        return;
      }
      rejectPromise(
        new Error(
          `${command} ${args.join(" ")} failed (${String(code)}, ${String(signal)}): ${stderr.trim()}`,
        ),
      );
    });
  });
}

function check(condition, message, failures) {
  if (!condition) failures.push(message);
}

function isMainModule() {
  return (
    process.argv[1] !== undefined &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}

if (isMainModule()) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const report = await inspectBootstrapAuth(options);
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (options.reportPath !== undefined) {
      await writeFile(options.reportPath, serialized, { mode: 0o600 });
    }
    process.stdout.write(serialized);
    if (report.status !== "pass") process.exitCode = 1;
  } catch (error) {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    const report = {
      failures: [message],
      report_kind: BOOTSTRAP_AUTH_REPORT_KIND,
      schema_version: BOOTSTRAP_AUTH_REPORT_SCHEMA_VERSION,
      status: "fail",
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
  }
}
