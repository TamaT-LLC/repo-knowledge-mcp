import {
  CanonicalStoreError,
  KnowledgeConflictError,
  type CanonicalStoreErrorCode,
} from "./canonical-transaction-store.js";
import {
  CanonicalFinalizeError,
  type CanonicalFinalizeErrorCode,
} from "./canonical-finalize-service.js";
import {
  DistillJobCoordinatorError,
  type DistillJobCoordinatorErrorCode,
} from "./distill-job-coordinator.js";
import {
  HostAssistedDistillationError,
  type HostAssistedDistillationErrorCode,
} from "./host-assisted-distillation-service.js";
import {
  IngestPrMutationError,
  type IngestPrMutationErrorCode,
} from "./ingest-pr-mutation-service.js";
import {
  MergeClassifierError,
  type MergeClassifierErrorCode,
} from "./merge-classifier.js";
import {
  ModelPlaneKnowledgeError,
  type ModelPlaneKnowledgeErrorCode,
} from "./model-plane-knowledge-service.js";
import { FileLockTimeoutError } from "./posix-file-lock.js";
import {
  ProviderPostIngestError,
  type ProviderPostIngestErrorCode,
} from "./provider-post-ingest-runner.js";
import {
  RecordOutcomeError,
  type RecordOutcomeErrorCode,
} from "./record-outcome-mutation-service.js";
import {
  RequestIntegrityError,
  type RequestIntegrityErrorCode,
} from "./request-integrity.js";
import {
  RepositoryResolutionError,
  type RepositoryResolutionErrorCode,
} from "./repository-resolver.js";
import {
  RuntimeFinalizeContextStoreError,
  type RuntimeFinalizeContextStoreErrorCode,
} from "./runtime-finalize-context-store.js";
import { SensitiveContentTransmissionError } from "./sensitive-content.js";
import {
  SubmitDistillationError,
  type SubmitDistillationErrorCode,
} from "./submit-distillation-service.js";
import {
  SyncCheckpointError,
  type SyncCheckpointErrorCode,
} from "./sync-checkpoint-store.js";
import { SyncCursorError, type SyncCursorErrorCode } from "./sync-cursor.js";
import { SyncRepoError, type SyncRepoErrorCode } from "./sync-repo-service.js";

export interface MutationToolErrorPayload {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly message: string;
  readonly next_action?: string;
  readonly retryable: boolean;
}

interface ErrorMappingRule {
  readonly nextAction?: string;
  readonly retryable: boolean;
}

type ErrorRuleTable<Code extends string> = {
  readonly [CurrentCode in Code]: ErrorMappingRule;
};

type CodedError<Code extends string = string> = Error & {
  readonly code: Code;
};

type MutationErrorTranslator = (
  error: unknown,
) => MutationToolErrorPayload | undefined;

const REINGEST_AND_PREPARE =
  "Re-ingest the pull request if needed, then call prepare_distillation again.";
const REFRESH_FENCED_LEASE =
  "Call prepare_distillation again to acquire the current fenced lease.";
const NON_RETRYABLE = { retryable: false } as const;
const RESOLVE_REPOSITORY = {
  nextAction:
    "Pass an unambiguous repo or an allowed workspace_path and retry.",
  retryable: false,
} as const;

const REPOSITORY_RESOLUTION_RULES = {
  GITHUB_GRAPHQL_ERROR: RESOLVE_REPOSITORY,
  GITHUB_RESPONSE_INVALID: RESOLVE_REPOSITORY,
  INVALID_REPOSITORY_NAME: RESOLVE_REPOSITORY,
  REPOSITORY_NOT_FOUND: RESOLVE_REPOSITORY,
  REPOSITORY_UNRESOLVED: RESOLVE_REPOSITORY,
  WORKSPACE_MAPPING_AMBIGUOUS: RESOLVE_REPOSITORY,
  WORKSPACE_NOT_FOUND: RESOLVE_REPOSITORY,
  WORKSPACE_PATH_UNSAFE: RESOLVE_REPOSITORY,
} satisfies ErrorRuleTable<RepositoryResolutionErrorCode>;

const SUBMIT_DISTILLATION_RULES = {
  CURRENT_SNAPSHOT_INCOMPLETE: NON_RETRYABLE,
  DISTILLATION_CONTEXT_CHANGED: {
    nextAction: REINGEST_AND_PREPARE,
    retryable: true,
  },
  DISTILLATION_SOURCE_CHANGED: {
    nextAction: REINGEST_AND_PREPARE,
    retryable: true,
  },
  EVIDENCE_COMMENTS_INVALID: NON_RETRYABLE,
  EXTRACT_REQUEST_INVALID: NON_RETRYABLE,
  FINALIZE_REQUEST_INVALID: NON_RETRYABLE,
  JOB_ALREADY_FINALIZED: NON_RETRYABLE,
  JOB_CONTEXT_MISMATCH: NON_RETRYABLE,
  MERGE_CANDIDATES_CHANGED: {
    nextAction:
      "Reclassify the returned current matches and retry finalize with the fresh handle.",
    retryable: true,
  },
  PHASE_ALREADY_COMMITTED: NON_RETRYABLE,
  RESUME_REQUIRED: {
    nextAction:
      "Call prepare_distillation again to acquire a fresh lease and finalize handle.",
    retryable: true,
  },
  UNKNOWN_FINALIZE_TOKEN: {
    nextAction:
      "Call prepare_distillation again to acquire a fresh lease and finalize handle.",
    retryable: true,
  },
} satisfies ErrorRuleTable<SubmitDistillationErrorCode>;

const DISTILL_JOB_RULES = {
  DISTILL_JOB_NOT_FOUND: NON_RETRYABLE,
  INVALID_ARGUMENT: NON_RETRYABLE,
  INVALID_LEASE_TOKEN: {
    nextAction: REFRESH_FENCED_LEASE,
    retryable: true,
  },
  STALE_LEASE: {
    nextAction: REFRESH_FENCED_LEASE,
    retryable: true,
  },
} satisfies ErrorRuleTable<DistillJobCoordinatorErrorCode>;

const HOST_ASSISTED_RULES = {
  DISTILLATION_CONTEXT_CHANGED: {
    nextAction: REINGEST_AND_PREPARE,
    retryable: true,
  },
  DISTILLATION_SOURCE_UNAVAILABLE: {
    nextAction: REINGEST_AND_PREPARE,
    retryable: true,
  },
  EXTRACT_RECEIPT_UNAVAILABLE: NON_RETRYABLE,
  INVALID_PREPARE_LIMIT: NON_RETRYABLE,
  LEASE_EXPIRED_DURING_PREPARE: {
    nextAction:
      "Call prepare_distillation again to acquire a fresh fenced lease.",
    retryable: true,
  },
} satisfies ErrorRuleTable<HostAssistedDistillationErrorCode>;

const CANONICAL_FINALIZE_RULES = {
  CURRENT_SNAPSHOT_INCOMPLETE: NON_RETRYABLE,
  DISTILLATION_CONTEXT_CHANGED: {
    nextAction: REINGEST_AND_PREPARE,
    retryable: true,
  },
  DISTILLATION_SOURCE_CHANGED: {
    nextAction: REINGEST_AND_PREPARE,
    retryable: true,
  },
  EVIDENCE_COMMENTS_INVALID: NON_RETRYABLE,
  FINALIZE_REQUEST_INVALID: NON_RETRYABLE,
  JOB_CONTEXT_MISMATCH: NON_RETRYABLE,
  MERGE_CANDIDATES_CHANGED: {
    nextAction:
      "Reclassify the current matches, then retry finalize with a fresh handle.",
    retryable: true,
  },
} satisfies ErrorRuleTable<CanonicalFinalizeErrorCode>;

const REQUEST_INTEGRITY_RULES = {
  IDEMPOTENCY_KEY_REUSED: {
    nextAction:
      "Keep the original request for this submission_id, or use a new submission_id for a different logical submission.",
    retryable: false,
  },
  INVALID_TOKEN: {
    nextAction:
      "Call prepare_distillation again and retry with the newly bound lease and handle.",
    retryable: true,
  },
  TOKEN_KIND_MISMATCH: {
    nextAction:
      "Call prepare_distillation again and retry with the newly bound lease and handle.",
    retryable: true,
  },
  TOKEN_REQUEST_MISMATCH: {
    nextAction:
      "Call prepare_distillation again and retry with the newly bound lease and handle.",
    retryable: true,
  },
} satisfies ErrorRuleTable<RequestIntegrityErrorCode>;

const RUNTIME_FINALIZE_RULES = {
  FINALIZE_CONTEXT_EXPIRED: {
    nextAction:
      "Call prepare_distillation again to acquire a fresh finalize handle.",
    retryable: true,
  },
  FINALIZE_CONTEXT_INVALID: NON_RETRYABLE,
  FINALIZE_TOKEN_COLLISION: NON_RETRYABLE,
} satisfies ErrorRuleTable<RuntimeFinalizeContextStoreErrorCode>;

const RECORD_OUTCOME_RULES = {
  IDEMPOTENCY_CONFLICT: {
    nextAction:
      "Reuse this event_id only to retry the identical payload; record a different outcome under a new event_id.",
    retryable: false,
  },
  KNOWLEDGE_NOT_ACTIVE: {
    nextAction:
      "Call get_rules for this repository and record outcomes only for the active knowledge ids it returns.",
    retryable: false,
  },
  KNOWLEDGE_NOT_FOUND: {
    nextAction:
      "Call get_rules for this repository and record outcomes only for the active knowledge ids it returns.",
    retryable: false,
  },
  KNOWLEDGE_REPOSITORY_MISMATCH: {
    nextAction:
      "Call get_rules for this repository and record outcomes only for the active knowledge ids it returns.",
    retryable: false,
  },
  RECORD_OUTCOME_REQUEST_INVALID: NON_RETRYABLE,
} satisfies ErrorRuleTable<RecordOutcomeErrorCode>;

const CANONICAL_STORE_RULES = {
  CANONICAL_LOG_CORRUPT: NON_RETRYABLE,
  CONFLICT: {
    nextAction:
      "Read the current canonical state, then retry from the new generation.",
    retryable: true,
  },
  INVALID_CANONICAL_PATH: NON_RETRYABLE,
  INVALID_TRANSACTION: NON_RETRYABLE,
  RECORD_ID_CONFLICT: NON_RETRYABLE,
  RECOVERY_CONFLICT: NON_RETRYABLE,
  UNRECOVERABLE_TRANSACTION: NON_RETRYABLE,
  UNSUPPORTED_PLATFORM: NON_RETRYABLE,
} satisfies ErrorRuleTable<CanonicalStoreErrorCode>;

const SYNC_REPO_RULES = {
  SYNC_CHECKPOINT_REPOSITORY_MISMATCH: NON_RETRYABLE,
  SYNC_REPOSITORY_MISMATCH: NON_RETRYABLE,
  SYNC_SINCE_BEYOND_CHECKPOINT: {
    nextAction:
      "Call sync_repo without since to resume from the stored checkpoint, or pass a boundary strictly older than it.",
    retryable: false,
  },
} satisfies ErrorRuleTable<SyncRepoErrorCode>;

const SYNC_CURSOR_RULES = {
  SYNC_BOUNDARY_CONFLICT: {
    nextAction: "Pass either since or a stored cursor boundary, never both.",
    retryable: false,
  },
  SYNC_CURSOR_INVALID: NON_RETRYABLE,
  SYNC_CURSOR_REPOSITORY_MISMATCH: NON_RETRYABLE,
  SYNC_CURSOR_VERSION_UNSUPPORTED: NON_RETRYABLE,
  SYNC_SINCE_INVALID: NON_RETRYABLE,
} satisfies ErrorRuleTable<SyncCursorErrorCode>;

const SYNC_CHECKPOINT_RULES = {
  SYNC_CHECKPOINT_INVALID: {
    nextAction:
      "Inspect and repair the repository sync/checkpoint.json file before syncing again.",
    retryable: false,
  },
  SYNC_CHECKPOINT_VERSION_UNSUPPORTED: {
    nextAction:
      "Inspect and repair the repository sync/checkpoint.json file before syncing again.",
    retryable: false,
  },
} satisfies ErrorRuleTable<SyncCheckpointErrorCode>;

const MERGE_CLASSIFIER_RULES = {
  MERGE_CLASSIFIER_TRANSMISSION_DENIED: NON_RETRYABLE,
  MERGE_DECISIONS_INVALID: NON_RETRYABLE,
  PROVIDER_MISMATCH: NON_RETRYABLE,
  PROVIDER_RESPONSE_INVALID: NON_RETRYABLE,
} satisfies ErrorRuleTable<MergeClassifierErrorCode>;

const INGEST_PR_RULES = {
  PROVIDER_PIPELINE_MISSING: NON_RETRYABLE,
  PROVIDER_SUMMARY_INVALID: NON_RETRYABLE,
} satisfies ErrorRuleTable<IngestPrMutationErrorCode>;

const PROVIDER_POST_INGEST_RULES = {
  INGEST_REPOSITORY_MISMATCH: NON_RETRYABLE,
  INGEST_SNAPSHOT_UNAVAILABLE: NON_RETRYABLE,
} satisfies ErrorRuleTable<ProviderPostIngestErrorCode>;

const MODEL_PLANE_KNOWLEDGE_RULES = {
  INVALID_KNOWLEDGE_STATE: NON_RETRYABLE,
  KNOWLEDGE_NOT_FOUND: NON_RETRYABLE,
  MODEL_PLANE_PROJECTION_INVALID: NON_RETRYABLE,
} satisfies ErrorRuleTable<ModelPlaneKnowledgeErrorCode>;

/** Priority is observable when error subclasses overlap; keep this order stable. */
const MUTATION_ERROR_TRANSLATORS = [
  translateSensitiveContentError,
  translateKnowledgeConflictError,
  translateRepositoryResolutionError,
  translateSubmitDistillationError,
  translateDistillJobError,
  translateHostAssistedError,
  translateCanonicalFinalizeError,
  translateRequestIntegrityError,
  translateRuntimeFinalizeError,
  translateRecordOutcomeError,
  translateCanonicalStoreError,
  translateSyncRepoError,
  translateSyncCursorError,
  translateSyncCheckpointError,
  translateFileLockError,
  translateProviderPipelineError,
  translateGenericCodedError,
] satisfies readonly MutationErrorTranslator[];

export function mapMutationError(error: unknown): MutationToolErrorPayload {
  for (const translate of MUTATION_ERROR_TRANSLATORS) {
    const mapped = translate(error);
    if (mapped !== undefined) return mapped;
  }
  return unknownMutationError(error);
}

function translateSensitiveContentError(
  error: unknown,
): MutationToolErrorPayload | undefined {
  if (!(error instanceof SensitiveContentTransmissionError)) return undefined;
  return {
    code: error.code,
    details: { findings: error.findings },
    message: error.message,
    next_action:
      "Remove or redact every flagged field at its source, then re-ingest and retry. For a false positive, rewrite the flagged text or keep external transmission disabled; do not bypass the scanner.",
    retryable: false,
  };
}

function translateKnowledgeConflictError(
  error: unknown,
): MutationToolErrorPayload | undefined {
  if (!(error instanceof KnowledgeConflictError)) return undefined;
  return {
    code: "KNOWLEDGE_CONFLICT",
    details: {
      current: {
        body: error.current.body,
        etag: error.current.etag,
        frontmatter: error.current.frontmatter,
        path: error.current.path,
        revision: error.current.revision,
      },
      current_etag: error.current.etag,
      current_revision: error.current.revision,
    },
    message: error.message,
    next_action:
      "Call get_knowledge, review the current generation, then submit a new proposal with both current CAS values.",
    retryable: true,
  };
}

function translateRepositoryResolutionError(
  error: unknown,
): MutationToolErrorPayload | undefined {
  if (!(error instanceof RepositoryResolutionError)) return undefined;
  const mapped = mapTableError(error, REPOSITORY_RESOLUTION_RULES);
  const details = {
    ...(error.candidates.length === 0 ? {} : { candidates: error.candidates }),
    ...(error.diagnostics.length === 0
      ? {}
      : { diagnostics: error.diagnostics }),
    ...(error.guidance.length === 0 ? {} : { guidance: error.guidance }),
  };
  return {
    ...mapped,
    ...(Object.keys(details).length === 0 ? {} : { details }),
    next_action:
      error.guidance.length > 0
        ? error.guidance.join(" ")
        : RESOLVE_REPOSITORY.nextAction,
  };
}

function translateSubmitDistillationError(
  error: unknown,
): MutationToolErrorPayload | undefined {
  if (!(error instanceof SubmitDistillationError)) return undefined;
  const mapped = mapTableError(error, SUBMIT_DISTILLATION_RULES);
  return error.code === "MERGE_CANDIDATES_CHANGED" && error.retry !== undefined
    ? { ...mapped, details: { retry: error.retry } }
    : mapped;
}

function translateDistillJobError(
  error: unknown,
): MutationToolErrorPayload | undefined {
  return error instanceof DistillJobCoordinatorError
    ? mapTableError(error, DISTILL_JOB_RULES)
    : undefined;
}

function translateHostAssistedError(
  error: unknown,
): MutationToolErrorPayload | undefined {
  return error instanceof HostAssistedDistillationError
    ? mapTableError(error, HOST_ASSISTED_RULES)
    : undefined;
}

function translateCanonicalFinalizeError(
  error: unknown,
): MutationToolErrorPayload | undefined {
  if (!(error instanceof CanonicalFinalizeError)) return undefined;
  const mapped = mapTableError(error, CANONICAL_FINALIZE_RULES);
  return error.code === "MERGE_CANDIDATES_CHANGED" &&
    error.currentSearch !== undefined
    ? { ...mapped, details: { current_search: error.currentSearch } }
    : mapped;
}

function translateRequestIntegrityError(
  error: unknown,
): MutationToolErrorPayload | undefined {
  return error instanceof RequestIntegrityError
    ? mapTableError(error, REQUEST_INTEGRITY_RULES)
    : undefined;
}

function translateRuntimeFinalizeError(
  error: unknown,
): MutationToolErrorPayload | undefined {
  return error instanceof RuntimeFinalizeContextStoreError
    ? mapTableError(error, RUNTIME_FINALIZE_RULES)
    : undefined;
}

function translateRecordOutcomeError(
  error: unknown,
): MutationToolErrorPayload | undefined {
  return error instanceof RecordOutcomeError
    ? mapTableError(error, RECORD_OUTCOME_RULES)
    : undefined;
}

function translateCanonicalStoreError(
  error: unknown,
): MutationToolErrorPayload | undefined {
  if (!(error instanceof CanonicalStoreError)) return undefined;
  const mapped = mapTableError(error, CANONICAL_STORE_RULES);
  return error.transactionId === undefined
    ? mapped
    : { ...mapped, details: { transaction_id: error.transactionId } };
}

function translateSyncRepoError(
  error: unknown,
): MutationToolErrorPayload | undefined {
  return error instanceof SyncRepoError
    ? mapTableError(error, SYNC_REPO_RULES)
    : undefined;
}

function translateSyncCursorError(
  error: unknown,
): MutationToolErrorPayload | undefined {
  return error instanceof SyncCursorError
    ? mapTableError(error, SYNC_CURSOR_RULES)
    : undefined;
}

function translateSyncCheckpointError(
  error: unknown,
): MutationToolErrorPayload | undefined {
  return error instanceof SyncCheckpointError
    ? mapTableError(error, SYNC_CHECKPOINT_RULES)
    : undefined;
}

function translateFileLockError(
  error: unknown,
): MutationToolErrorPayload | undefined {
  if (!(error instanceof FileLockTimeoutError)) return undefined;
  return mapKnownError(error, {
    nextAction:
      "Another run holds the repository sync lock; wait for it to finish, then call sync_repo again.",
    retryable: true,
  });
}

function translateProviderPipelineError(
  error: unknown,
): MutationToolErrorPayload | undefined {
  if (error instanceof MergeClassifierError) {
    return mapTableError(error, MERGE_CLASSIFIER_RULES);
  }
  if (error instanceof IngestPrMutationError) {
    return mapTableError(error, INGEST_PR_RULES);
  }
  if (error instanceof ProviderPostIngestError) {
    return mapTableError(error, PROVIDER_POST_INGEST_RULES);
  }
  if (error instanceof ModelPlaneKnowledgeError) {
    return mapTableError(error, MODEL_PLANE_KNOWLEDGE_RULES);
  }
  return undefined;
}

function translateGenericCodedError(
  error: unknown,
): MutationToolErrorPayload | undefined {
  return isCodedError(error) ? mapKnownError(error, NON_RETRYABLE) : undefined;
}

function mapTableError<Code extends string>(
  error: CodedError<Code>,
  rules: ErrorRuleTable<Code>,
): MutationToolErrorPayload {
  return mapKnownError(error, rules[error.code]);
}

function mapKnownError(
  error: CodedError,
  rule: ErrorMappingRule,
): MutationToolErrorPayload {
  return {
    code: error.code,
    message: error.message,
    ...(rule.nextAction === undefined ? {} : { next_action: rule.nextAction }),
    retryable: rule.retryable,
  };
}

function unknownMutationError(error: unknown): MutationToolErrorPayload {
  return {
    code: "MUTATION_FAILED",
    message: error instanceof Error ? error.message : "Mutation failed",
    retryable: false,
  };
}

function isCodedError(error: unknown): error is CodedError {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.length > 0
  );
}
