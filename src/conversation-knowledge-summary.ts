import { z } from "zod";
import { IsoDateTimeSchema } from "./domain-schemas.js";
import type { CanonicalProjectionSnapshot } from "./sqlite-projection.js";
import type { KnowledgeFrontmatter } from "./knowledge-document.js";

const hint = z.object({
  kind: z.enum(["hook", "skill", "permission", "prose"]),
  rationale: z.string(),
});
export const ConversationSummarySchema = z.strictObject({
  session_count: z.number().int().nonnegative(),
  project_count: z.number().int().nonnegative(),
  period: z
    .object({ from: IsoDateTimeSchema, to: IsoDateTimeSchema })
    .nullable(),
  enforcement_hint: hint.nullable(),
  has_conflict: z.boolean(),
});

const ConversationOriginSchema = z.object({
  source: z.literal("conversation"),
});

export function isConversationKnowledge(frontmatter: KnowledgeFrontmatter) {
  return ConversationOriginSchema.validate(frontmatter.origin);
}

/** Expose only aggregates from canonical events, never their IDs or raw payload. */
export function conversationSummary(
  snapshot: CanonicalProjectionSnapshot,
  frontmatter: KnowledgeFrontmatter,
): z.infer<typeof ConversationSummarySchema> {
  const supports = new Map<
    string,
    { session_key: string; project_key: string; observed_at: string }
  >();
  const sessions = new Set<string>(),
    projects = new Set<string>();
  const evidence = snapshot.records.flatMap(({ record, targetPath }) => {
    if (
      targetPath !== "events/conversation_evidence.jsonl" ||
      !record.payload ||
      typeof record.payload !== "object" ||
      Array.isArray(record.payload)
    )
      return [];
    return [
      {
        type: record.record_type,
        payload: record.payload as Record<string, unknown>,
      },
    ];
  });
  const hasConflict = evidence.some(
    ({ type, payload }) =>
      type === "ConversationConflictRecorded" &&
      Array.isArray(payload.knowledge_ids) &&
      payload.knowledge_ids.includes(frontmatter.id) &&
      payload.knowledge_ids.every((id) =>
        snapshot.domain.knowledge.some(
          (k) =>
            k.id === id && k.status !== "deprecated" && k.status !== "rejected",
        ),
      ),
  );
  for (const { type, payload: e } of evidence) {
    if (typeof e.evidence_id !== "string") continue;
    if (
      type === "ConversationEvidenceSuperseded" ||
      type === "ConversationEvidenceWithdrawn"
    )
      supports.delete(e.evidence_id);
    if (
      type === "ConversationEvidenceCreated" &&
      e.knowledge_id === frontmatter.id &&
      e.polarity === "supports" &&
      e.status === "active" &&
      typeof e.session_key === "string" &&
      typeof e.project_key === "string" &&
      typeof e.observed_at === "string"
    )
      supports.set(e.evidence_id, {
        session_key: e.session_key,
        project_key: e.project_key,
        observed_at: e.observed_at,
      });
  }
  const dates = [];
  for (const e of supports.values()) {
    if (!IsoDateTimeSchema.validate(e.observed_at)) continue;
    sessions.add(e.session_key);
    projects.add(e.project_key);
    dates.push(e.observed_at);
  }
  dates.sort((a, b) => Date.parse(a) - Date.parse(b));
  const parsed = hint.safeParse(frontmatter.enforcement_hint);
  return {
    session_count: sessions.size,
    project_count: projects.size,
    period: dates.length ? { from: dates[0]!, to: dates.at(-1)! } : null,
    has_conflict: hasConflict,
    enforcement_hint: parsed.success ? parsed.data : null,
  };
}
