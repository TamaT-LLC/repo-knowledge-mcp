import { join } from "node:path";

import { z } from "zod";

import { RepositoryNameSchema } from "./domain-schemas.js";
import { formatConfigIssues } from "./config.js";
import { ProjectPathSchema } from "./conversation-paths.js";
import { MAX_UTTERANCE_TEXT_CHARACTERS } from "./conversation-records.js";
import { openRegularFileNoFollow } from "./durable-fs.js";

/** Separate from `config.json`, which old versions validate strictly. */
export const CONVERSATION_CONFIG_FILE_NAME = "conversation-distillation.json";

export type ConversationConfigErrorCode =
  | "CONVERSATION_CONFIG_INVALID"
  | "CONVERSATION_CONFIG_IO_ERROR"
  | "CONVERSATION_CONFIG_PATH_UNSAFE";

export class ConversationConfigError extends Error {
  constructor(
    readonly code: ConversationConfigErrorCode,
    readonly path: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${path}: ${message}`, options);
    this.name = "ConversationConfigError";
  }
}

const NonEmptyTrimmedStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "must not be blank");

/**
 * `/…` is a path-component prefix; anything else is an exact `owner/name`
 * (design: config). A relative path such as `clients/secret` therefore reads
 * as a repository name; write paths in absolute form.
 */
const ExcludedProjectSchema = z.string().transform((value, context) => {
  // Chosen by the leading `/`, so an error names the form that was meant.
  const parsed = (
    value.startsWith("/") ? ProjectPathSchema : RepositoryNameSchema
  ).safeParse(value);
  if (parsed.success) return parsed.data;
  for (const issue of parsed.error.issues) {
    context.addIssue({ code: "custom", message: issue.message });
  }
  return z.NEVER;
});

const SourceSchema = (home: string) =>
  z
    .object({
      enabled: z.boolean().default(false),
      home: NonEmptyTrimmedStringSchema.default(home),
    })
    .strict()
    .prefault({});

const SdkAllowlistEntrySchema = z
  .object({
    cwdPrefix: ProjectPathSchema.optional(),
    entrypoint: NonEmptyTrimmedStringSchema.optional(),
  })
  .strict()
  .refine(
    (entry) => entry.cwdPrefix !== undefined || entry.entrypoint !== undefined,
    "must set entrypoint or cwdPrefix",
  );

const RegularExpressionSchema = z.string().refine((value) => {
  try {
    new RegExp(value, "u");
    return true;
  } catch {
    return false;
  }
}, "must be a valid regular expression");

const PositiveIntegerSchema = z.number().int().positive();

const ConversationDistillationConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    enabled: z.boolean().default(false),
    sources: z
      .object({
        claudeCode: SourceSchema("~/.claude"),
        codex: SourceSchema("~/.codex"),
      })
      .strict()
      .prefault({}),
    provider: z
      .object({
        allowConversationContentTransmission: z.boolean().default(false),
        consentedMode: NonEmptyTrimmedStringSchema.nullable().default(null),
      })
      .strict()
      .prefault({}),
    hostAssisted: z
      .object({
        allowConversationContentTransmission: z.boolean().default(false),
        allowGlobalStore: z.boolean().default(false),
        enabled: z.boolean().default(false),
      })
      .strict()
      .prefault({}),
    assistantContext: z
      .object({
        enabled: z.boolean().default(true),
        maxCharacters: PositiveIntegerSchema.max(
          MAX_UTTERANCE_TEXT_CHARACTERS,
        ).default(500),
      })
      .strict()
      .prefault({}),
    /** `null` keeps utterances indefinitely. */
    retentionDays: PositiveIntegerSchema.max(36_500).nullable().default(null),
    redactTerms: z.array(NonEmptyTrimmedStringSchema).default([]),
    sdkAllowlist: z.array(SdkAllowlistEntrySchema).default([]),
    automationPatterns: z.array(RegularExpressionSchema).default([]),
    correctionKeywords: z.array(NonEmptyTrimmedStringSchema).default([]),
    excludeProjects: z.array(ExcludedProjectSchema).default([]),
    thresholds: z
      .object({
        global: z
          .object({
            minProjects: PositiveIntegerSchema.default(2),
            minSessions: PositiveIntegerSchema.default(3),
          })
          .strict()
          .prefault({}),
        noRepository: z
          .object({ minSessions: PositiveIntegerSchema.default(3) })
          .strict()
          .prefault({}),
        repository: z
          .object({ minSessions: PositiveIntegerSchema.default(2) })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type ConversationDistillationConfig = z.infer<
  typeof ConversationDistillationConfigSchema
>;

export interface LoadedConversationConfig {
  readonly config: ConversationDistillationConfig;
  /** False when group or others can access the file and it was left so. */
  readonly private: boolean;
  /** False when the file is absent: every conversation feature is off. */
  readonly present: boolean;
}

/** Defaults with everything disabled, used when the file is absent. */
export function disabledConversationConfig(): ConversationDistillationConfig {
  return ConversationDistillationConfigSchema.parse({ schemaVersion: 1 });
}

export function parseConversationDistillationConfig(
  value: unknown,
  path = "<conversation-config>",
): ConversationDistillationConfig {
  const result = ConversationDistillationConfigSchema.safeParse(value);
  if (result.success) return result.data;
  // Locations and messages only: values may be dictionary terms.
  throw new ConversationConfigError(
    "CONVERSATION_CONFIG_INVALID",
    path,
    formatConfigIssues(result.error.issues),
  );
}

/**
 * Loads `conversation-distillation.json` from the storage root. A missing
 * file disables every conversation feature. The file holds the user
 * dictionary, so it is kept at `0600` like `config.json`.
 */
export async function loadConversationDistillationConfig(
  storageRoot: string,
  options: {
    /** Read-only callers (status) report loose permissions, not fix them. */
    readonly tightenPermissions?: boolean;
  } = {},
): Promise<LoadedConversationConfig> {
  let isPrivate = true;
  const path = join(storageRoot, CONVERSATION_CONFIG_FILE_NAME);
  let bytes: Buffer;
  try {
    // One handle opened without following links: the mode check, chmod
    // and read all apply to the same file.
    const opened = await openRegularFileNoFollow(
      path,
      () =>
        new ConversationConfigError(
          "CONVERSATION_CONFIG_PATH_UNSAFE",
          path,
          "must be a regular file, not a symlink",
        ),
    );
    if (opened === null) {
      return {
        config: disabledConversationConfig(),
        present: false,
        private: true,
      };
    }
    try {
      if ((opened.status.mode & 0o077) !== 0) {
        if (options.tightenPermissions === false) isPrivate = false;
        else await opened.handle.chmod(0o600);
      }
      bytes = await opened.handle.readFile();
    } finally {
      await opened.handle.close();
    }
  } catch (error) {
    if (error instanceof ConversationConfigError) throw error;
    throw new ConversationConfigError(
      "CONVERSATION_CONFIG_IO_ERROR",
      path,
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    // The parser's message can quote file content; keep it out.
    throw new ConversationConfigError(
      "CONVERSATION_CONFIG_INVALID",
      path,
      "file is not valid UTF-8 JSON",
    );
  }
  return {
    config: parseConversationDistillationConfig(value, path),
    present: true,
    private: isPrivate,
  };
}
