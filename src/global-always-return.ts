import { z } from "zod";
import {
  EventIdSchema,
  IsoDateTimeSchema,
  KnowledgeIdSchema,
  RepositoryIdSchema,
} from "./domain-schemas.js";
import type { ProjectedCanonicalRecord } from "./sqlite-projection.js";

export const GLOBAL_STORE_ID = "rk:global";
export const ALWAYS_RETURN_PATH = "events/always_return.jsonl";
export const ALWAYS_RETURN_LIMIT = 3;
export const AlwaysReturnChangeSchema = z
  .object({
    actor: z.enum(["cli", "mcp"]),
    caller_repo_id: RepositoryIdSchema.optional(),
    enabled: z.boolean(),
    event_id: EventIdSchema,
    knowledge_id: KnowledgeIdSchema,
    recorded_at: IsoDateTimeSchema,
  })
  .strict()
  .refine((e) => (e.actor === "mcp") === (e.caller_repo_id !== undefined));

export const AlwaysReturnResultSchema = z
  .object({
    state: z.enum(["changed", "unchanged", "rejected"]),
    knowledge_id: KnowledgeIdSchema,
    always_return: z.boolean(),
    set_by: z.enum(["cli", "mcp"]).optional(),
    always_return_count: z.number().int().min(0).max(ALWAYS_RETURN_LIMIT),
    reason: z
      .enum(["not_global", "not_active", "limit_reached", "set_by_cli"])
      .optional(),
  })
  .strict();
export type AlwaysReturnChange = z.infer<typeof AlwaysReturnChangeSchema>;
export type AlwaysReturnResult = z.infer<typeof AlwaysReturnResultSchema>;
export type AlwaysReturnActor =
  | { actor: "cli" }
  | { actor: "mcp"; caller_repo_id: string };

/** Replay in canonical append order, which also resolves equal timestamps. */
export function latestAlwaysReturn(
  records: readonly ProjectedCanonicalRecord[],
) {
  const latest = new Map<string, AlwaysReturnChange>();
  for (const { record, targetPath } of records) {
    if (
      targetPath === ALWAYS_RETURN_PATH &&
      record.record_type === "GlobalAlwaysReturnChanged"
    ) {
      const event = AlwaysReturnChangeSchema.parse(record.payload);
      latest.set(event.knowledge_id, event);
    }
  }
  return latest;
}
