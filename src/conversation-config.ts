import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  RepoKnowledgeConfigError,
  parseConfigWithSchema,
  readJsonConfigFile,
  resolveStorageRoot,
} from "./config.js";
import { RepositoryNameSchema } from "./domain-schemas.js";
import { LLM_PROVIDER_MODES } from "./llm-provider-config.js";

export const CONVERSATION_CONFIG_FILE_NAME = "conversation-distillation.json";

/** A strict settings object whose omitted fields take their defaults. */
const section = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object(shape)
    .strict()
    .prefault({} as never);
const source = (home: string) =>
  section({
    enabled: z.boolean().default(false),
    home: z.string().min(1).default(home),
  });
const count = (value: number) => z.number().int().positive().default(value);

/** A `/`-prefixed absolute path prefix or an exact `owner/name`. */
const ProjectSelectorStringSchema = z
  .string()
  .refine(
    (value) =>
      value.startsWith("/") || RepositoryNameSchema.safeParse(value).success,
    "must be an absolute path or owner/name",
  );

/**
 * `conversation-distillation.json`. Kept apart from the strict `config.json`
 * so older releases never see unknown keys; a missing file disables
 * everything.
 */
const ConversationDistillationConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    enabled: z.boolean().default(false),
    sources: section({
      claudeCode: source("~/.claude"),
      codex: source("~/.codex"),
    }),
    provider: section({
      allowConversationContentTransmission: z.boolean().default(false),
      consentedMode: z.enum(LLM_PROVIDER_MODES).nullable().default(null),
    }),
    hostAssisted: section({
      enabled: z.boolean().default(false),
      allowConversationContentTransmission: z.boolean().default(false),
      allowGlobalStore: z.boolean().default(false),
    }),
    assistantContext: section({
      enabled: z.boolean().default(true),
      maxCharacters: count(500),
    }),
    retentionDays: z.number().int().positive().nullable().default(null),
    redactTerms: z.array(z.string().trim().min(1)).default([]),
    sdkAllowlist: z
      .array(
        z
          .object({
            entrypoint: z.string().min(1).optional(),
            cwdPrefix: z.string().startsWith("/").optional(),
          })
          .strict()
          .refine(
            (entry) =>
              entry.entrypoint !== undefined || entry.cwdPrefix !== undefined,
            "requires entrypoint or cwdPrefix",
          ),
      )
      .default([]),
    automationPatterns: z
      .array(
        z.string().refine((pattern) => {
          try {
            new RegExp(pattern, "u");
            return true;
          } catch {
            return false;
          }
        }, "must be a valid regular expression"),
      )
      .default([]),
    correctionKeywords: z.array(z.string().trim().min(1)).default([]),
    excludeProjects: z.array(ProjectSelectorStringSchema).default([]),
    thresholds: section({
      repository: section({ minSessions: count(2) }),
      global: section({ minProjects: count(2), minSessions: count(3) }),
      noRepository: section({ minSessions: count(3) }),
    }),
  })
  .strict();

export type ConversationDistillationConfig = z.infer<
  typeof ConversationDistillationConfigSchema
>;

/** Reads the conversation config; never creates it. */
export async function loadConversationConfig(
  storageRoot: string,
): Promise<ConversationDistillationConfig> {
  const path = join(
    resolveStorageRoot(storageRoot),
    CONVERSATION_CONFIG_FILE_NAME,
  );
  const status = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw new RepoKnowledgeConfigError("CONFIG_IO_ERROR", path, error.message, {
      cause: error,
    });
  });
  // redactTerms can hold third-party names; never read it from a shared file.
  // A symlink or non-file is left to readJsonConfigFile's own error.
  if (status?.isFile() === true && (status.mode & 0o077) !== 0) {
    throw new RepoKnowledgeConfigError(
      "CONFIG_PATH_UNSAFE",
      path,
      "must not be readable by group or others; run chmod 600",
    );
  }
  return parseConfigWithSchema(
    ConversationDistillationConfigSchema,
    status === null ? { schemaVersion: 1 } : await readJsonConfigFile(path),
    path,
  );
}
