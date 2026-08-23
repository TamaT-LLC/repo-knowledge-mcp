import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalizeJson } from "./canonical.js";
import type { CanonicalJsonlRecord } from "./canonical-jsonl.js";
import type { CanonicalTransactionStore } from "./canonical-transaction-store.js";
import type { ProjectedKnowledgeOutcome } from "./domain-projection.js";
import {
  EventIdSchema,
  IsoDateTimeSchema,
  KnowledgeIdSchema,
  KnowledgeOutcomeSchema,
  NonEmptyStringSchema,
  RepositoryIdSchema,
  RepositoryNameSchema,
  TransactionIdSchema,
  type KnowledgeOutcome,
} from "./domain-schemas.js";
import { createDomainId } from "./ids.js";
import {
  KnowledgeReadError,
  normalizeRepositoryFilePath,
} from "./knowledge-read-service.js";
import type { CanonicalProjectionSnapshot } from "./sqlite-projection.js";

export const OUTCOME_EVENT_PATH = "events/outcomes.jsonl";
export const OUTCOME_RECORDED_RECORD_TYPE = "OutcomeRecorded";

export const MAX_OUTCOME_NOTE_LENGTH = 2_000;
export const MAX_OUTCOME_TASK_ID_LENGTH = 128;
export const MAX_OUTCOME_EVENT_KEY_LENGTH = 256;
export const MAX_OUTCOME_FILE_PATHS = 50;
export const MAX_OUTCOME_FILE_PATH_LENGTH = 512;

export const OutcomeKindSchema = z.enum([
  "applied",
  "violated",
  "not_applicable",
  "false_positive",
]);
export type OutcomeKind = z.infer<typeof OutcomeKindSchema>;

export const OutcomeEventKeySchema = z
  .string()
  .transform((value) => value.normalize("NFKC").trim())
  .pipe(NonEmptyStringSchema.max(MAX_OUTCOME_EVENT_KEY_LENGTH));

const RecordOutcomeContextSchema = z
  .object({
    file_paths: z
      .array(NonEmptyStringSchema.max(MAX_OUTCOME_FILE_PATH_LENGTH))
      .min(1)
      .max(MAX_OUTCOME_FILE_PATHS)
      .optional(),
    pr_number: z.number().int().positive().optional(),
    task_id: NonEmptyStringSchema.max(MAX_OUTCOME_TASK_ID_LENGTH).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "context must contain at least one field",
  });

export const RecordOutcomeRequestSchema = z
  .object({
    at: IsoDateTimeSchema,
    context: RecordOutcomeContextSchema.optional(),
    event_id: EventIdSchema.optional().describe(
      "Compatibility path for a caller-generated idempotency key. Supply exactly one of event_id or event_key.",
    ),
    event_key: OutcomeEventKeySchema.optional().describe(
      "Stable host work-result key used to derive event_id deterministically. Reuse the exact request for retries.",
    ),
    knowledge_id: KnowledgeIdSchema,
    note: NonEmptyStringSchema.max(MAX_OUTCOME_NOTE_LENGTH).optional(),
    outcome: OutcomeKindSchema,
    result_observed: z
      .literal(true)
      .optional()
      .describe(
        "Required with event_key. Assert only after the host observes applicability or a real work result; get_rules retrieval alone is not an outcome.",
      ),
  })
  .strict()
  .superRefine((request, context) => {
    const hasEventId = request.event_id !== undefined;
    const hasEventKey = request.event_key !== undefined;
    if (hasEventId === hasEventKey) {
      context.addIssue({
        code: "custom",
        message: "supply exactly one of event_id or event_key",
        path: ["event_key"],
      });
    }
    if (!hasEventKey) return;
    if (request.result_observed !== true) {
      context.addIssue({
        code: "custom",
        message: "event_key requires result_observed: true",
        path: ["result_observed"],
      });
    }
    if (request.context === undefined) {
      context.addIssue({
        code: "custom",
        message: "event_key requires observable task context",
        path: ["context"],
      });
    }
    if (request.note === undefined) {
      context.addIssue({
        code: "custom",
        message: "event_key requires a note describing the observed result",
        path: ["note"],
      });
    }
  });

export type RecordOutcomeRequest = z.infer<typeof RecordOutcomeRequestSchema>;

export type RecordOutcomeErrorCode =
  | "IDEMPOTENCY_CONFLICT"
  | "KNOWLEDGE_NOT_ACTIVE"
  | "KNOWLEDGE_NOT_FOUND"
  | "KNOWLEDGE_REPOSITORY_MISMATCH"
  | "RECORD_OUTCOME_REQUEST_INVALID";

export class RecordOutcomeError extends Error {
  constructor(
    readonly code: RecordOutcomeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "RecordOutcomeError";
  }
}

export interface RecordOutcomeResult {
  readonly applied_count: number;
  readonly event_id: string;
  readonly knowledge_id: string;
  readonly outcome: OutcomeKind;
  readonly replayed: boolean;
  readonly violation_count: number;
}

export interface RecordOutcomeMutationServiceOptions {
  readonly nextTransactionId?: (timestamp: number) => string;
  readonly now?: () => Date;
  readonly repo: string;
  readonly repoId: string;
  readonly repository: CanonicalTransactionStore;
}

interface BoundOutcomePayload {
  readonly eventId: string;
  readonly payload: KnowledgeOutcome;
}

export interface DeriveOutcomeEventIdRequest {
  readonly eventKey: string;
  readonly knowledgeId: string;
  readonly repoId: string;
}

const CROCKFORD_BASE32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Derives a stable event-shaped ID from one host-observed work-result key.
 * The stable repository ID and knowledge ID prevent cross-binding, while a
 * 128-bit SHA-256 prefix keeps collisions negligible without exposing the key.
 */
export function deriveOutcomeEventId(
  request: DeriveOutcomeEventIdRequest,
): string {
  const eventKey = OutcomeEventKeySchema.parse(request.eventKey);
  const knowledgeId = KnowledgeIdSchema.parse(request.knowledgeId);
  const repoId = RepositoryIdSchema.parse(request.repoId);
  const digest = createHash("sha256")
    .update(
      canonicalizeJson({
        event_key: eventKey,
        knowledge_id: knowledgeId,
        repo_id: repoId,
        schema_version: 1,
      }),
      "utf8",
    )
    .digest("hex")
    .slice(0, 32);
  return EventIdSchema.parse(`evt_${encodeCrockford128(digest)}`);
}

/**
 * Records agent-observed rule outcomes as canonical OutcomeRecorded events.
 *
 * The `event_id` is bound one-to-one to the canonical record ID, so a replay
 * of the same payload returns the already-committed result without a second
 * append, while a different payload under the same `event_id` fails closed.
 * Counters are never mutated directly: they remain derivable by folding the
 * canonical event log (reindex rebuilds the same aggregates).
 */
export class RecordOutcomeMutationService {
  readonly repo: string;
  readonly repoId: string;

  private readonly nextTransactionId: (timestamp: number) => string;
  private readonly now: () => Date;
  private readonly repository: CanonicalTransactionStore;

  constructor(options: RecordOutcomeMutationServiceOptions) {
    this.repo = RepositoryNameSchema.parse(options.repo);
    this.repoId = RepositoryIdSchema.parse(options.repoId);
    this.repository = options.repository;
    this.now = options.now ?? (() => new Date());
    this.nextTransactionId =
      options.nextTransactionId ??
      ((timestamp) => createDomainId("transaction", timestamp));
  }

  async recordOutcome(request: unknown): Promise<RecordOutcomeResult> {
    const bound = this.bindOutcomePayload(request);

    return this.repository.runLockedMutation((snapshot) => {
      const existing = snapshot.domain.outcomes.find(
        (outcome) => outcome.recordId === bound.eventId,
      );
      if (existing !== undefined) {
        assertReplayPayloadMatches(existing, bound);
        return {
          transaction: null,
          value: this.buildResult(snapshot, bound, true),
        };
      }

      this.assertActiveKnowledgeBinding(snapshot, bound);
      const operation = this.now();
      const transactionId = TransactionIdSchema.parse(
        this.nextTransactionId(operation.getTime()),
      );
      const record: CanonicalJsonlRecord = {
        payload: bound.payload,
        record_id: bound.eventId,
        record_type: OUTCOME_RECORDED_RECORD_TYPE,
        recorded_at: operation.toISOString(),
        schema_version: 1,
        transaction_id: transactionId,
      };
      return {
        transaction: {
          appendRecords: [{ record, targetPath: OUTCOME_EVENT_PATH }],
          createdAt: operation.toISOString(),
          fileWrites: [],
          transactionId,
        },
        value: this.buildResult(snapshot, bound, false),
      };
    });
  }

  private bindOutcomePayload(request: unknown): BoundOutcomePayload {
    const parsed = RecordOutcomeRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new RecordOutcomeError(
        "RECORD_OUTCOME_REQUEST_INVALID",
        parsed.error.message,
        { cause: parsed.error },
      );
    }

    const context = normalizeOutcomeContext(parsed.data.context);
    const payload = KnowledgeOutcomeSchema.parse({
      at: parsed.data.at,
      ...(context === undefined ? {} : { context }),
      knowledge_id: parsed.data.knowledge_id,
      ...(parsed.data.note === undefined ? {} : { note: parsed.data.note }),
      outcome: parsed.data.outcome,
      repo_id: this.repoId,
    });
    const eventKey = parsed.data.event_key;
    let eventId = parsed.data.event_id;
    if (eventId === undefined) {
      if (eventKey === undefined) {
        throw new TypeError("validated outcome request has no event identity");
      }
      eventId = deriveOutcomeEventId({
        eventKey,
        knowledgeId: parsed.data.knowledge_id,
        repoId: this.repoId,
      });
    }
    return { eventId, payload };
  }

  private assertActiveKnowledgeBinding(
    snapshot: CanonicalProjectionSnapshot,
    bound: BoundOutcomePayload,
  ): void {
    const knowledge = snapshot.domain.knowledge.find(
      (candidate) => candidate.id === bound.payload.knowledge_id,
    );
    if (knowledge === undefined) {
      throw new RecordOutcomeError(
        "KNOWLEDGE_NOT_FOUND",
        `knowledge ${bound.payload.knowledge_id} was not found in this repository`,
      );
    }
    if (knowledge.repoId !== this.repoId) {
      throw new RecordOutcomeError(
        "KNOWLEDGE_REPOSITORY_MISMATCH",
        `knowledge ${bound.payload.knowledge_id} belongs to repository ${knowledge.repoId}, not ${this.repoId}`,
      );
    }
    if (knowledge.status !== "active") {
      throw new RecordOutcomeError(
        "KNOWLEDGE_NOT_ACTIVE",
        `knowledge ${bound.payload.knowledge_id} is ${knowledge.status}; outcomes require active knowledge`,
      );
    }
  }

  private buildResult(
    snapshot: CanonicalProjectionSnapshot,
    bound: BoundOutcomePayload,
    replayed: boolean,
  ): RecordOutcomeResult {
    let appliedCount = 0;
    let violationCount = 0;
    for (const outcome of snapshot.domain.outcomes) {
      if (
        outcome.repo_id !== this.repoId ||
        outcome.knowledge_id !== bound.payload.knowledge_id
      ) {
        continue;
      }
      if (outcome.outcome === "applied") appliedCount += 1;
      if (outcome.outcome === "violated") violationCount += 1;
    }
    if (!replayed) {
      if (bound.payload.outcome === "applied") appliedCount += 1;
      if (bound.payload.outcome === "violated") violationCount += 1;
    }

    return {
      applied_count: appliedCount,
      event_id: bound.eventId,
      knowledge_id: bound.payload.knowledge_id,
      outcome: bound.payload.outcome,
      replayed,
      violation_count: violationCount,
    };
  }
}

function encodeCrockford128(hex: string): string {
  let remaining = BigInt(`0x${hex}`);
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = CROCKFORD_BASE32_ALPHABET[Number(remaining & 31n)]! + encoded;
    remaining >>= 5n;
  }
  return encoded;
}

function normalizeOutcomeContext(
  context: RecordOutcomeRequest["context"],
): KnowledgeOutcome["context"] {
  if (context === undefined) return undefined;
  if (context.file_paths === undefined) return context;

  let filePaths: string[];
  try {
    filePaths = context.file_paths.map(normalizeRepositoryFilePath);
  } catch (error) {
    if (error instanceof KnowledgeReadError) {
      throw new RecordOutcomeError(
        "RECORD_OUTCOME_REQUEST_INVALID",
        error.message,
        { cause: error },
      );
    }
    throw error;
  }
  return { ...context, file_paths: filePaths };
}

function assertReplayPayloadMatches(
  existing: ProjectedKnowledgeOutcome,
  bound: BoundOutcomePayload,
): void {
  const existingPayload: KnowledgeOutcome = {
    at: existing.at,
    ...(existing.context === undefined ? {} : { context: existing.context }),
    knowledge_id: existing.knowledge_id,
    ...(existing.note === undefined ? {} : { note: existing.note }),
    outcome: existing.outcome,
    repo_id: existing.repo_id,
  };
  if (canonicalizeJson(existingPayload) !== canonicalizeJson(bound.payload)) {
    throw new RecordOutcomeError(
      "IDEMPOTENCY_CONFLICT",
      `event ${bound.eventId} is already bound to a different outcome payload`,
    );
  }
}
