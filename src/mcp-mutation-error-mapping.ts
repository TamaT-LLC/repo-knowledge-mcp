import {
  CanonicalStoreError,
  KnowledgeConflictError,
} from "./canonical-transaction-store.js";
import { CanonicalFinalizeError } from "./canonical-finalize-service.js";
import { DistillJobCoordinatorError } from "./distill-job-coordinator.js";
import { HostAssistedDistillationError } from "./host-assisted-distillation-service.js";
import { IngestPrMutationError } from "./ingest-pr-mutation-service.js";
import { MergeClassifierError } from "./merge-classifier.js";
import { ModelPlaneKnowledgeError } from "./model-plane-knowledge-service.js";
import { FileLockTimeoutError } from "./posix-file-lock.js";
import { ProviderPostIngestError } from "./provider-post-ingest-runner.js";
import { RecordOutcomeError } from "./record-outcome-mutation-service.js";
import { RequestIntegrityError } from "./request-integrity.js";
import { RepositoryResolutionError } from "./repository-resolver.js";
import { RuntimeFinalizeContextStoreError } from "./runtime-finalize-context-store.js";
import { SensitiveContentTransmissionError } from "./sensitive-content.js";
import { SubmitDistillationError } from "./submit-distillation-service.js";
import { SyncCheckpointError } from "./sync-checkpoint-store.js";
import { SyncCursorError } from "./sync-cursor.js";
import { SyncRepoError } from "./sync-repo-service.js";

export interface MutationToolErrorPayload {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly message: string;
  readonly next_action?: string;
  readonly retryable: boolean;
}

export function mapMutationError(error: unknown): MutationToolErrorPayload {
  if (error instanceof SensitiveContentTransmissionError) {
    return {
      code: error.code,
      details: { findings: error.findings },
      message: error.message,
      next_action:
        "Remove or redact every flagged field at its source, then re-ingest and retry. For a false positive, rewrite the flagged text or keep external transmission disabled; do not bypass the scanner.",
      retryable: false,
    };
  }

  if (error instanceof KnowledgeConflictError) {
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

  if (error instanceof RepositoryResolutionError) {
    const details = {
      ...(error.candidates.length === 0
        ? {}
        : { candidates: error.candidates }),
      ...(error.diagnostics.length === 0
        ? {}
        : { diagnostics: error.diagnostics }),
      ...(error.guidance.length === 0 ? {} : { guidance: error.guidance }),
    };
    return {
      code: error.code,
      ...(Object.keys(details).length === 0 ? {} : { details }),
      message: error.message,
      next_action:
        error.guidance.length > 0
          ? error.guidance.join(" ")
          : "Pass an unambiguous repo or an allowed workspace_path and retry.",
      retryable: false,
    };
  }

  if (error instanceof SubmitDistillationError) {
    if (error.code === "MERGE_CANDIDATES_CHANGED") {
      return {
        code: error.code,
        ...(error.retry === undefined
          ? {}
          : { details: { retry: error.retry } }),
        message: error.message,
        next_action:
          "Reclassify the returned current matches and retry finalize with the fresh handle.",
        retryable: true,
      };
    }
    if (
      error.code === "UNKNOWN_FINALIZE_TOKEN" ||
      error.code === "RESUME_REQUIRED"
    ) {
      return {
        code: error.code,
        message: error.message,
        next_action:
          "Call prepare_distillation again to acquire a fresh lease and finalize handle.",
        retryable: true,
      };
    }
    if (
      error.code === "DISTILLATION_CONTEXT_CHANGED" ||
      error.code === "DISTILLATION_SOURCE_CHANGED"
    ) {
      return {
        code: error.code,
        message: error.message,
        next_action:
          "Re-ingest the pull request if needed, then call prepare_distillation again.",
        retryable: true,
      };
    }
    return knownError(error, false);
  }

  if (error instanceof DistillJobCoordinatorError) {
    const retryable =
      error.code === "STALE_LEASE" || error.code === "INVALID_LEASE_TOKEN";
    return {
      ...knownError(error, retryable),
      ...(retryable
        ? {
            next_action:
              "Call prepare_distillation again to acquire the current fenced lease.",
          }
        : {}),
    };
  }

  if (
    error instanceof HostAssistedDistillationError ||
    error instanceof CanonicalFinalizeError
  ) {
    if (
      error.code === "DISTILLATION_CONTEXT_CHANGED" ||
      error.code === "DISTILLATION_SOURCE_CHANGED" ||
      error.code === "DISTILLATION_SOURCE_UNAVAILABLE"
    ) {
      return {
        ...knownError(error, true),
        next_action:
          "Re-ingest the pull request if needed, then call prepare_distillation again.",
      };
    }
    if (error.code === "LEASE_EXPIRED_DURING_PREPARE") {
      return {
        ...knownError(error, true),
        next_action:
          "Call prepare_distillation again to acquire a fresh fenced lease.",
      };
    }
    if (
      error instanceof CanonicalFinalizeError &&
      error.code === "MERGE_CANDIDATES_CHANGED"
    ) {
      return {
        ...knownError(error, true),
        ...(error.currentSearch === undefined
          ? {}
          : { details: { current_search: error.currentSearch } }),
        next_action:
          "Reclassify the current matches, then retry finalize with a fresh handle.",
      };
    }
    return knownError(error, false);
  }

  if (error instanceof RequestIntegrityError) {
    if (error.code === "IDEMPOTENCY_KEY_REUSED") {
      return {
        ...knownError(error, false),
        next_action:
          "Keep the original request for this submission_id, or use a new submission_id for a different logical submission.",
      };
    }
    return {
      ...knownError(error, true),
      next_action:
        "Call prepare_distillation again and retry with the newly bound lease and handle.",
    };
  }

  if (error instanceof RuntimeFinalizeContextStoreError) {
    if (error.code === "FINALIZE_CONTEXT_EXPIRED") {
      return {
        ...knownError(error, true),
        next_action:
          "Call prepare_distillation again to acquire a fresh finalize handle.",
      };
    }
    return knownError(error, false);
  }

  if (error instanceof RecordOutcomeError) {
    if (error.code === "IDEMPOTENCY_CONFLICT") {
      return {
        ...knownError(error, false),
        next_action:
          "Reuse this event_id only to retry the identical payload; record a different outcome under a new event_id.",
      };
    }
    if (
      error.code === "KNOWLEDGE_NOT_ACTIVE" ||
      error.code === "KNOWLEDGE_NOT_FOUND" ||
      error.code === "KNOWLEDGE_REPOSITORY_MISMATCH"
    ) {
      return {
        ...knownError(error, false),
        next_action:
          "Call get_rules for this repository and record outcomes only for the active knowledge ids it returns.",
      };
    }
    return knownError(error, false);
  }

  if (error instanceof CanonicalStoreError) {
    const retryable = error.code === "CONFLICT";
    return {
      ...knownError(error, retryable),
      ...(error.transactionId === undefined
        ? {}
        : { details: { transaction_id: error.transactionId } }),
      ...(retryable
        ? {
            next_action:
              "Read the current canonical state, then retry from the new generation.",
          }
        : {}),
    };
  }

  if (error instanceof SyncRepoError) {
    if (error.code === "SYNC_SINCE_BEYOND_CHECKPOINT") {
      return {
        ...knownError(error, false),
        next_action:
          "Call sync_repo without since to resume from the stored checkpoint, or pass a boundary strictly older than it.",
      };
    }
    return knownError(error, false);
  }

  if (error instanceof SyncCursorError) {
    if (error.code === "SYNC_BOUNDARY_CONFLICT") {
      return {
        ...knownError(error, false),
        next_action:
          "Pass either since or a stored cursor boundary, never both.",
      };
    }
    return knownError(error, false);
  }

  if (error instanceof SyncCheckpointError) {
    return {
      ...knownError(error, false),
      next_action:
        "Inspect and repair the repository sync/checkpoint.json file before syncing again.",
    };
  }

  if (error instanceof FileLockTimeoutError) {
    return {
      ...knownError(error, true),
      next_action:
        "Another run holds the repository sync lock; wait for it to finish, then call sync_repo again.",
    };
  }

  if (
    error instanceof MergeClassifierError ||
    error instanceof IngestPrMutationError ||
    error instanceof ProviderPostIngestError ||
    error instanceof ModelPlaneKnowledgeError
  ) {
    return knownError(error, false);
  }

  if (isCodedError(error)) return knownError(error, false);

  return {
    code: "MUTATION_FAILED",
    message: error instanceof Error ? error.message : "Mutation failed",
    retryable: false,
  };
}

function knownError(
  error: Error & { readonly code: string },
  retryable: boolean,
): MutationToolErrorPayload {
  return { code: error.code, message: error.message, retryable };
}

function isCodedError(
  error: unknown,
): error is Error & { readonly code: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.length > 0
  );
}
