import { join } from "node:path";

import { z } from "zod";

import {
  parseConfigWithSchema,
  readJsonConfigFile,
  resolveStorageRoot,
} from "./config.js";
import { RepositoryNameSchema } from "./domain-schemas.js";
import { pathExists } from "./durable-fs.js";
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
  return parseConfigWithSchema(
    ConversationDistillationConfigSchema,
    (await pathExists(path))
      ? await readJsonConfigFile(path)
      : { schemaVersion: 1 },
    path,
  );
}
