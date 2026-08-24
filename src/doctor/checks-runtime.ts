import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";

import Database from "better-sqlite3";

import {
  DEFAULT_CONFIG_FILE_NAME,
  loadRepoKnowledgeConfig,
} from "../config.js";
import type { RepoKnowledgeConfig } from "../domain-schemas.js";
import { getLlmProviderDefinition } from "../llm-provider-config.js";
import type { LlmSubscriptionInspectorLike } from "../subscription-cli-provider.js";
import { DoctorReportBuilder } from "./report-builder.js";
import {
  errorCode,
  errorMessage,
  isSupportedNodeVersion,
  octal,
  unsignedFilesystemType,
} from "./util.js";

const NETWORK_FILESYSTEM_TYPES = new Map<number, string>([
  [0x0000_6969, "NFS"],
  [0x0000_517b, "SMB"],
  [0xff53_4d42, "CIFS"],
  [0xfe53_4d42, "SMB2"],
  [0x5346_414f, "AFS"],
  [0x0102_1997, "9P"],
]);
const SYNCHRONIZED_PATH =
  /(?:^|[/\\])(?:Dropbox|Google Drive|Mobile Documents|OneDrive)(?:[/\\]|$)/iu;

export function checkRuntime(
  report: DoctorReportBuilder,
  nodeVersion: string,
  platform: NodeJS.Platform,
): void {
  const supportedNode = isSupportedNodeVersion(nodeVersion);
  report.add(
    supportedNode
      ? {
          details: { version: nodeVersion },
          id: "runtime.node",
          message: "Node.js version is supported.",
          status: "pass",
        }
      : {
          details: { version: nodeVersion },
          id: "runtime.node",
          message: "Node.js must be 22.13 or newer in the 22 line, or 24+.",
          remedy: "Install a supported Node.js release and rerun doctor.",
          status: "fail",
        },
  );
  const supportedPlatform = platform === "darwin" || platform === "linux";
  report.add(
    supportedPlatform
      ? {
          details: { platform },
          id: "runtime.os",
          message: "Operating system is supported by the M1 storage model.",
          status: "pass",
        }
      : {
          details: { platform },
          id: "runtime.os",
          message: "M1 supports only macOS and Linux.",
          remedy: "Use repo-knowledge on macOS or Linux.",
          status: "fail",
        },
  );
}

export async function checkTransmissionConfiguration(
  report: DoctorReportBuilder,
  config: RepoKnowledgeConfig | null,
  subscriptionInspector: LlmSubscriptionInspectorLike,
): Promise<void> {
  if (config === null) {
    for (const id of [
      "config.provider_transmission",
      "config.host_assisted_transmission",
    ]) {
      report.add({
        id,
        message:
          "Transmission consent could not be checked without valid config.",
        status: "warn",
      });
    }
    return;
  }
  const provider = config.llm;
  if (provider.mode === "disabled" && provider.allowCloudTransmission) {
    report.add({
      id: "config.provider_transmission",
      message:
        "Cloud transmission consent is true while the provider mode is disabled.",
      remedy:
        "Set llm.allowCloudTransmission to false, or configure mode and model intentionally.",
      status: "warn",
    });
  } else if (provider.mode !== "disabled" && !provider.allowCloudTransmission) {
    const definition = getLlmProviderDefinition(provider.mode);
    report.add({
      id: "config.provider_transmission",
      message: `${definition.displayName} mode is configured but cloud transmission consent is false; provider calls remain disabled.`,
      remedy:
        "Either set mode to disabled or explicitly enable allowCloudTransmission after reviewing data disclosure.",
      status: "warn",
    });
  } else if (
    provider.mode !== "disabled" &&
    provider.allowCloudTransmission &&
    provider.model === null
  ) {
    const definition = getLlmProviderDefinition(provider.mode);
    report.add({
      id: "config.provider_transmission",
      message: `Enabled ${definition.displayName} transmission has no configured model.`,
      remedy: "Set llm.model before running provider distillation.",
      status: "fail",
    });
  } else if (provider.mode !== "disabled") {
    const definition = getLlmProviderDefinition(provider.mode);
    const subscription = await subscriptionInspector.inspect(provider.mode);
    if (!subscription.cliAvailable) {
      report.add({
        id: "config.provider_transmission",
        message: `Enabled ${definition.displayName} transmission cannot find the ${definition.cliExecutable} CLI.`,
        remedy: `Install ${definition.displayName}, then run ${definition.loginCommand}.`,
        status: "fail",
      });
    } else if (!subscription.authenticated) {
      report.add({
        id: "config.provider_transmission",
        message: `Enabled ${definition.displayName} transmission has no usable subscription login.`,
        remedy: `Run ${definition.loginCommand} and choose subscription sign-in, then rerun doctor.`,
        status: "fail",
      });
    } else {
      report.add({
        details: {
          authentication: subscription.method ?? "subscription",
          cli: definition.cliExecutable,
        },
        id: "config.provider_transmission",
        message: `${definition.displayName} mode, model, consent, and subscription login are coherent.`,
        status: "pass",
      });
    }
  } else {
    report.add({
      id: "config.provider_transmission",
      message: "Provider transmission is safely disabled.",
      status: "pass",
    });
  }

  const host = config.hostAssistedDistillation;
  if (host.enabled !== host.allowReviewContentTransmission) {
    report.add({
      id: "config.host_assisted_transmission",
      message:
        "Host-assisted mode requires both enabled and allowReviewContentTransmission; review content remains unavailable.",
      remedy:
        "Set both host-assisted consent fields to false, or intentionally enable both after reviewing disclosure.",
      status: "warn",
    });
  } else {
    report.add({
      id: "config.host_assisted_transmission",
      message: host.enabled
        ? "Host-assisted transmission has both required opt-ins."
        : "Host-assisted transmission is safely disabled.",
      status: "pass",
    });
  }
}

export async function inspectSqliteFeatures(
  report: DoctorReportBuilder,
): Promise<void> {
  const database = new Database(":memory:");
  try {
    database.exec(
      "CREATE VIRTUAL TABLE doctor_fts USING fts5(value, tokenize='trigram')",
    );
    database.prepare("INSERT INTO doctor_fts(value) VALUES (?)").run("doctor");
    const row = database
      .prepare(
        "SELECT count(*) AS count FROM doctor_fts WHERE doctor_fts MATCH ?",
      )
      .get('"doctor"') as { count: number };
    if (row.count !== 1) throw new Error("trigram query returned no row");
    report.add({
      id: "sqlite.features",
      message: "SQLite FTS5 and the trigram tokenizer are available.",
      status: "pass",
    });
  } catch (error) {
    report.add({
      details: { error: errorMessage(error) },
      id: "sqlite.features",
      message: "SQLite FTS5 or the trigram tokenizer is unavailable.",
      remedy:
        "Use the supported prebuilt better-sqlite3 runtime for this Node.js version.",
      status: "fail",
    });
  } finally {
    database.close();
  }
}

export async function inspectStorage(
  report: DoctorReportBuilder,
  storageRoot: string,
  filesystemTypeReader: (path: string) => Promise<bigint | number>,
): Promise<boolean> {
  let metadata: Stats;
  try {
    metadata = await lstat(storageRoot);
  } catch (error) {
    report.add({
      id: "storage.permissions",
      message: "Storage root does not exist or cannot be inspected.",
      path: storageRoot,
      remedy:
        "Run a normal repo-knowledge setup command to create private storage, then rerun doctor.",
      status: "fail",
      details: { error: errorCode(error) },
    });
    report.add({
      id: "storage.local_filesystem",
      message: "Local-filesystem support could not be checked without storage.",
      path: storageRoot,
      status: "warn",
    });
    return false;
  }
  const permission = metadata.mode & 0o777;
  const privateDirectory =
    metadata.isDirectory() &&
    !metadata.isSymbolicLink() &&
    permission === 0o700;
  report.add(
    privateDirectory
      ? {
          id: "storage.permissions",
          message: "Storage root is a real directory with mode 700.",
          path: storageRoot,
          status: "pass",
        }
      : {
          details: { mode: octal(permission) },
          id: "storage.permissions",
          message:
            "Storage root must be a non-symlink directory with mode 700.",
          path: storageRoot,
          remedy: `Move storage to a private directory and run chmod 700 ${storageRoot}.`,
          status: "fail",
        },
  );

  if (SYNCHRONIZED_PATH.test(storageRoot)) {
    report.add({
      id: "storage.local_filesystem",
      message: "Storage appears to be inside a synchronized filesystem path.",
      path: storageRoot,
      remedy:
        "Move REPO_KNOWLEDGE_HOME to a local, non-synchronized filesystem.",
      status: "fail",
    });
    return true;
  }
  try {
    const type = unsignedFilesystemType(
      await filesystemTypeReader(storageRoot),
    );
    const networkName = NETWORK_FILESYSTEM_TYPES.get(type);
    report.add(
      networkName === undefined
        ? {
            details: { filesystem_type: `0x${type.toString(16)}` },
            id: "storage.local_filesystem",
            message:
              "Storage is not on a recognized network filesystem or sync path.",
            path: storageRoot,
            status: "pass",
          }
        : {
            details: { filesystem: networkName },
            id: "storage.local_filesystem",
            message: `${networkName} storage is outside the M1 durability guarantee.`,
            path: storageRoot,
            remedy:
              "Move REPO_KNOWLEDGE_HOME to a local filesystem before writing canonical state.",
            status: "fail",
          },
    );
  } catch (error) {
    report.add({
      details: { error: errorCode(error) },
      id: "storage.local_filesystem",
      message: "Filesystem type could not be determined.",
      path: storageRoot,
      remedy:
        "Confirm manually that storage is local and not NFS, SMB, Dropbox, iCloud, or another sync area.",
      status: "warn",
    });
  }
  return true;
}

export async function inspectConfig(
  report: DoctorReportBuilder,
  storageRoot: string,
): Promise<RepoKnowledgeConfig | null> {
  const configPath = join(storageRoot, DEFAULT_CONFIG_FILE_NAME);
  let config: RepoKnowledgeConfig;
  try {
    config = await loadRepoKnowledgeConfig(configPath);
    report.add({
      id: "config.syntax",
      message: "Configuration is valid and uses the supported schema.",
      path: configPath,
      status: "pass",
    });
  } catch (error) {
    report.add({
      details: { error: errorMessage(error) },
      id: "config.syntax",
      message: "Configuration could not be parsed safely.",
      path: configPath,
      remedy: `Fix ${configPath}; doctor does not rewrite invalid configuration.`,
      status: "fail",
    });
    report.add({
      id: "config.permissions",
      message: "Config permissions were not trusted because parsing failed.",
      path: configPath,
      status: "warn",
    });
    return null;
  }
  try {
    const metadata = await lstat(configPath);
    const permission = metadata.mode & 0o777;
    const valid =
      metadata.isFile() && !metadata.isSymbolicLink() && permission === 0o600;
    report.add(
      valid
        ? {
            id: "config.permissions",
            message: "Config is a regular file with mode 600.",
            path: configPath,
            status: "pass",
          }
        : {
            details: { mode: octal(permission) },
            id: "config.permissions",
            message: "Config must be a non-symlink regular file with mode 600.",
            path: configPath,
            remedy: `Replace any symlink and run chmod 600 ${configPath}.`,
            status: "fail",
          },
    );
  } catch (error) {
    report.add({
      details: { error: errorCode(error) },
      id: "config.permissions",
      message: "Config permissions could not be inspected.",
      path: configPath,
      status: "fail",
    });
  }
  return config;
}
