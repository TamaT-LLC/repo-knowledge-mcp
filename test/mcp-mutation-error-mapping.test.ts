import { describe, expect, it } from "vitest";

import {
  CanonicalFinalizeError,
  type CanonicalFinalizeErrorCode,
} from "../src/canonical-finalize-service.js";
import {
  CanonicalStoreError,
  KnowledgeConflictError,
  type CanonicalStoreErrorCode,
} from "../src/canonical-transaction-store.js";
import {
  DistillJobCoordinatorError,
  type DistillJobCoordinatorErrorCode,
} from "../src/distill-job-coordinator.js";
import {
  HostAssistedDistillationError,
  type HostAssistedDistillationErrorCode,
} from "../src/host-assisted-distillation-service.js";
import {
  IngestPrMutationError,
  type IngestPrMutationErrorCode,
} from "../src/ingest-pr-mutation-service.js";
import { GitHubSnapshotError } from "../src/github-graphql.js";
import {
  MergeClassifierError,
  type MergeClassifierErrorCode,
} from "../src/merge-classifier.js";
import type { MergeCandidateSearchResult } from "../src/merge-candidate-service.js";
import { mapMutationError } from "../src/mcp-mutation-error-mapping.js";
import {
  ModelPlaneKnowledgeError,
  type ModelPlaneKnowledgeErrorCode,
} from "../src/model-plane-knowledge-service.js";
import { FileLockTimeoutError } from "../src/posix-file-lock.js";
import {
  ProviderPostIngestError,
  type ProviderPostIngestErrorCode,
} from "../src/provider-post-ingest-runner.js";
import {
  RecordOutcomeError,
  type RecordOutcomeErrorCode,
} from "../src/record-outcome-mutation-service.js";
import {
  RequestIntegrityError,
  type RequestIntegrityErrorCode,
} from "../src/request-integrity.js";
import {
  RepositoryResolutionError,
  type RepositoryResolutionErrorCode,
} from "../src/repository-resolver.js";
import {
  RuntimeFinalizeContextStoreError,
  type RuntimeFinalizeContextStoreErrorCode,
} from "../src/runtime-finalize-context-store.js";
import { SensitiveContentTransmissionError } from "../src/sensitive-content.js";
import {
  SubmitDistillationError,
  type SubmitDistillationErrorCode,
  type SubmitFinalizeRetryResponse,
} from "../src/submit-distillation-service.js";
import {
  SyncCheckpointError,
  type SyncCheckpointErrorCode,
} from "../src/sync-checkpoint-store.js";
import {
  SyncCursorError,
  type SyncCursorErrorCode,
} from "../src/sync-cursor.js";
import {
  SyncRepoError,
  type SyncRepoErrorCode,
} from "../src/sync-repo-service.js";

interface ExpectedRule {
  readonly nextAction?: string;
  readonly retryable: boolean;
}

type ExpectedRuleTable<Code extends string> = {
  readonly [CurrentCode in Code]: ExpectedRule;
};

interface CodedError<Code extends string> extends Error {
  readonly code: Code;
}

interface MappingCase {
  readonly error: Error;
  readonly expected: Readonly<Record<string, unknown>>;
  readonly label: string;
}

const REINGEST_AND_PREPARE =
  "Re-ingest the pull request if needed, then call prepare_distillation again.";
const REFRESH_FENCED_LEASE =
  "Call prepare_distillation again to acquire the current fenced lease.";
const RESOLVE_REPOSITORY =
  "Pass an unambiguous repo or an allowed workspace_path and retry.";
const NON_RETRYABLE = { retryable: false } as const;

const REPOSITORY_RULES = {
  GITHUB_GRAPHQL_ERROR: { nextAction: RESOLVE_REPOSITORY, retryable: false },
  GITHUB_RESPONSE_INVALID: {
    nextAction: RESOLVE_REPOSITORY,
    retryable: false,
  },
  INVALID_REPOSITORY_NAME: {
    nextAction: RESOLVE_REPOSITORY,
    retryable: false,
  },
  REPOSITORY_NOT_FOUND: {
    nextAction: RESOLVE_REPOSITORY,
    retryable: false,
  },
  REPOSITORY_UNRESOLVED: {
    nextAction: RESOLVE_REPOSITORY,
    retryable: false,
  },
  WORKSPACE_MAPPING_AMBIGUOUS: {
    nextAction: RESOLVE_REPOSITORY,
    retryable: false,
  },
  WORKSPACE_NOT_FOUND: {
    nextAction: RESOLVE_REPOSITORY,
    retryable: false,
  },
  WORKSPACE_PATH_UNSAFE: {
    nextAction: RESOLVE_REPOSITORY,
    retryable: false,
  },
} satisfies ExpectedRuleTable<RepositoryResolutionErrorCode>;

const SUBMIT_RULES = {
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
} satisfies ExpectedRuleTable<SubmitDistillationErrorCode>;

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
} satisfies ExpectedRuleTable<DistillJobCoordinatorErrorCode>;

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
} satisfies ExpectedRuleTable<HostAssistedDistillationErrorCode>;

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
} satisfies ExpectedRuleTable<CanonicalFinalizeErrorCode>;

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
} satisfies ExpectedRuleTable<RequestIntegrityErrorCode>;

const RUNTIME_FINALIZE_RULES = {
  FINALIZE_CONTEXT_EXPIRED: {
    nextAction:
      "Call prepare_distillation again to acquire a fresh finalize handle.",
    retryable: true,
  },
  FINALIZE_CONTEXT_INVALID: NON_RETRYABLE,
  FINALIZE_TOKEN_COLLISION: NON_RETRYABLE,
} satisfies ExpectedRuleTable<RuntimeFinalizeContextStoreErrorCode>;

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
} satisfies ExpectedRuleTable<RecordOutcomeErrorCode>;

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
} satisfies ExpectedRuleTable<CanonicalStoreErrorCode>;

const SYNC_REPO_RULES = {
  SYNC_CHECKPOINT_REPOSITORY_MISMATCH: NON_RETRYABLE,
  SYNC_REPOSITORY_MISMATCH: NON_RETRYABLE,
  SYNC_SINCE_BEYOND_CHECKPOINT: {
    nextAction:
      "Call sync_repo without since to resume from the stored checkpoint, or pass a boundary strictly older than it.",
    retryable: false,
  },
} satisfies ExpectedRuleTable<SyncRepoErrorCode>;

const SYNC_CURSOR_RULES = {
  SYNC_BOUNDARY_CONFLICT: {
    nextAction: "Pass either since or a stored cursor boundary, never both.",
    retryable: false,
  },
  SYNC_CURSOR_INVALID: NON_RETRYABLE,
  SYNC_CURSOR_REPOSITORY_MISMATCH: NON_RETRYABLE,
  SYNC_CURSOR_VERSION_UNSUPPORTED: NON_RETRYABLE,
  SYNC_SINCE_INVALID: NON_RETRYABLE,
} satisfies ExpectedRuleTable<SyncCursorErrorCode>;

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
} satisfies ExpectedRuleTable<SyncCheckpointErrorCode>;

const MERGE_CLASSIFIER_RULES = {
  MERGE_CLASSIFIER_TRANSMISSION_DENIED: NON_RETRYABLE,
  MERGE_DECISIONS_INVALID: NON_RETRYABLE,
  PROVIDER_MISMATCH: NON_RETRYABLE,
  PROVIDER_RESPONSE_INVALID: NON_RETRYABLE,
} satisfies ExpectedRuleTable<MergeClassifierErrorCode>;

const INGEST_PR_RULES = {
  PROVIDER_PIPELINE_MISSING: NON_RETRYABLE,
  PROVIDER_SUMMARY_INVALID: NON_RETRYABLE,
} satisfies ExpectedRuleTable<IngestPrMutationErrorCode>;

const PROVIDER_POST_INGEST_RULES = {
  INGEST_REPOSITORY_MISMATCH: NON_RETRYABLE,
  INGEST_SNAPSHOT_UNAVAILABLE: NON_RETRYABLE,
} satisfies ExpectedRuleTable<ProviderPostIngestErrorCode>;

const MODEL_PLANE_RULES = {
  INVALID_KNOWLEDGE_STATE: NON_RETRYABLE,
  KNOWLEDGE_NOT_FOUND: NON_RETRYABLE,
  MODEL_PLANE_PROJECTION_INVALID: NON_RETRYABLE,
} satisfies ExpectedRuleTable<ModelPlaneKnowledgeErrorCode>;

const KNOWN_ERROR_CASES = [
  ...mappingCases(
    "repository",
    REPOSITORY_RULES,
    (code) => new RepositoryResolutionError(code, "message"),
  ),
  ...mappingCases(
    "submit",
    SUBMIT_RULES,
    (code) => new SubmitDistillationError(code, "message"),
  ),
  ...mappingCases(
    "distill job",
    DISTILL_JOB_RULES,
    (code) => new DistillJobCoordinatorError(code, "message"),
  ),
  ...mappingCases(
    "host-assisted",
    HOST_ASSISTED_RULES,
    (code) => new HostAssistedDistillationError(code, "message"),
  ),
  ...mappingCases(
    "canonical finalize",
    CANONICAL_FINALIZE_RULES,
    (code) => new CanonicalFinalizeError(code, "message"),
  ),
  ...mappingCases(
    "request integrity",
    REQUEST_INTEGRITY_RULES,
    (code) => new RequestIntegrityError(code, "message"),
  ),
  ...mappingCases(
    "runtime finalize",
    RUNTIME_FINALIZE_RULES,
    (code) => new RuntimeFinalizeContextStoreError(code, "message"),
  ),
  ...mappingCases(
    "record outcome",
    RECORD_OUTCOME_RULES,
    (code) => new RecordOutcomeError(code, "message"),
  ),
  ...mappingCases(
    "canonical store",
    CANONICAL_STORE_RULES,
    (code) => new CanonicalStoreError(code, "message"),
  ),
  ...mappingCases(
    "sync repo",
    SYNC_REPO_RULES,
    (code) => new SyncRepoError(code, "message"),
  ),
  ...mappingCases(
    "sync cursor",
    SYNC_CURSOR_RULES,
    (code) => new SyncCursorError(code, "message"),
  ),
  ...mappingCases(
    "sync checkpoint",
    SYNC_CHECKPOINT_RULES,
    (code) => new SyncCheckpointError(code, "message"),
  ),
  ...mappingCases(
    "merge classifier",
    MERGE_CLASSIFIER_RULES,
    (code) => new MergeClassifierError(code, "message"),
  ),
  ...mappingCases(
    "ingest PR",
    INGEST_PR_RULES,
    (code) => new IngestPrMutationError(code, "message"),
  ),
  ...mappingCases(
    "provider post-ingest",
    PROVIDER_POST_INGEST_RULES,
    (code) => new ProviderPostIngestError(code, "message"),
  ),
  ...mappingCases(
    "model plane",
    MODEL_PLANE_RULES,
    (code) => new ModelPlaneKnowledgeError(code, "message"),
  ),
];

describe("mapMutationError", () => {
  it.each(KNOWN_ERROR_CASES)("maps $label", ({ error, expected }) => {
    expect(mapMutationError(error)).toEqual(expected);
  });

  it("preserves sensitive finding metadata without adding content", () => {
    const error = new SensitiveContentTransmissionError(
      "host_assisted_payload",
      [{ kind: "email_address", path: "$.comments[0].body" }],
    );

    expect(mapMutationError(error)).toEqual({
      code: "SENSITIVE_CONTENT_DETECTED",
      details: {
        findings: [{ kind: "email_address", path: "$.comments[0].body" }],
      },
      message: error.message,
      next_action:
        "Remove or redact every flagged field at its source, then re-ingest and retry. For a false positive, rewrite the flagged text or keep external transmission disabled; do not bypass the scanner.",
      retryable: false,
    });
  });

  it("preserves the knowledge conflict CAS snapshot", () => {
    const current = {
      body: "Current body",
      etag: "sha256:current",
      frontmatter: {
        id: "kn_current",
        repo_id: "R_current",
        revision: 2,
        schema_version: 1 as const,
      },
      path: "knowledge/current.md",
      revision: 2,
    };
    const error = new KnowledgeConflictError(current);

    expect(mapMutationError(error)).toEqual({
      code: "KNOWLEDGE_CONFLICT",
      details: {
        current,
        current_etag: current.etag,
        current_revision: current.revision,
      },
      message: error.message,
      next_action:
        "Call get_knowledge, review the current generation, then submit a new proposal with both current CAS values.",
      retryable: true,
    });
  });

  it("preserves repository diagnostics and joins explicit guidance", () => {
    const error = new RepositoryResolutionError(
      "WORKSPACE_MAPPING_AMBIGUOUS",
      "message",
      {
        candidates: ["owner/one", "owner/two"],
        diagnostics: ["multiple mappings"],
        guidance: ["Pass repo.", "Retry."],
      },
    );

    expect(mapMutationError(error)).toEqual({
      code: error.code,
      details: {
        candidates: error.candidates,
        diagnostics: error.diagnostics,
        guidance: error.guidance,
      },
      message: error.message,
      next_action: "Pass repo. Retry.",
      retryable: false,
    });
  });

  it("preserves submit retry metadata", () => {
    const retry = {
      candidate_set_sha256: "sha256:candidates",
      finalize_handle: {
        expires_at: "2026-08-25T00:00:00.000Z",
        finalize_token: "finalize-token",
        lease_generation: 2,
      },
      match_set_digest: "sha256:matches",
      possible_matches: [],
      state: "merge_decision_required",
    } satisfies SubmitFinalizeRetryResponse;
    const error = new SubmitDistillationError(
      "MERGE_CANDIDATES_CHANGED",
      "message",
      { retry },
    );

    expect(mapMutationError(error)).toEqual({
      ...expectedPayload(error, SUBMIT_RULES.MERGE_CANDIDATES_CHANGED),
      details: { retry },
    });
  });

  it("preserves current search details for canonical finalize retries", () => {
    const currentSearch = {
      candidates: [],
      match_set_digest: "sha256:matches",
      possible_matches: [],
    } satisfies MergeCandidateSearchResult;
    const error = new CanonicalFinalizeError(
      "MERGE_CANDIDATES_CHANGED",
      "message",
      currentSearch,
    );

    expect(mapMutationError(error)).toEqual({
      ...expectedPayload(
        error,
        CANONICAL_FINALIZE_RULES.MERGE_CANDIDATES_CHANGED,
      ),
      details: { current_search: currentSearch },
    });
  });

  it("preserves a canonical transaction id", () => {
    const error = new CanonicalStoreError("CONFLICT", "message", "txn_current");

    expect(mapMutationError(error)).toEqual({
      ...expectedPayload(error, CANONICAL_STORE_RULES.CONFLICT),
      details: { transaction_id: "txn_current" },
    });
  });

  it("maps lock timeout retry guidance", () => {
    const error = new FileLockTimeoutError("/repo/sync/.lock");

    expect(mapMutationError(error)).toEqual({
      code: "LOCK_TIMEOUT",
      message: error.message,
      next_action:
        "Another run holds the repository sync lock; wait for it to finish, then call sync_repo again.",
      retryable: true,
    });
  });

  it("maps an exhausted pull-request listing change as retryable", () => {
    const error = new GitHubSnapshotError(
      "PULL_REQUEST_LIST_CHANGED",
      "pullRequests page",
      "pull request listing changed while it was being enumerated",
    );

    expect(mapMutationError(error)).toEqual({
      code: "PULL_REQUEST_LIST_CHANGED",
      message: error.message,
      next_action: expect.stringContaining("same arguments"),
      retryable: true,
    });
  });

  it("keeps the generic coded-error fallback", () => {
    const error = Object.assign(new Error("external failure"), {
      code: "EXTERNAL_FAILURE",
    });

    expect(mapMutationError(error)).toEqual({
      code: "EXTERNAL_FAILURE",
      message: "external failure",
      retryable: false,
    });
  });

  it("keeps a stable fallback for a runtime code outside its typed table", () => {
    const error = new SyncCursorError(
      "SYNC_CURSOR_FUTURE" as SyncCursorErrorCode,
      "future code",
    );

    expect(mapMutationError(error)).toEqual({
      code: "SYNC_CURSOR_FUTURE",
      message: error.message,
      retryable: false,
    });
  });

  it.each([
    {
      error: new Error("outer failure", {
        cause: new SyncCursorError("SYNC_CURSOR_INVALID", "inner failure"),
      }),
      expectedMessage: "outer failure",
      label: "nested cause",
    },
    {
      error: new Error("plain failure"),
      expectedMessage: "plain failure",
      label: "unknown Error",
    },
    {
      error: { reason: "plain value" },
      expectedMessage: "Mutation failed",
      label: "unknown value",
    },
  ])("keeps the $label fallback", ({ error, expectedMessage }) => {
    expect(mapMutationError(error)).toEqual({
      code: "MUTATION_FAILED",
      message: expectedMessage,
      retryable: false,
    });
  });
});

function mappingCases<Code extends string>(
  subsystem: string,
  rules: ExpectedRuleTable<Code>,
  createError: (code: Code) => CodedError<Code>,
): MappingCase[] {
  return (Object.keys(rules) as Code[]).map((code) => {
    const error = createError(code);
    return {
      error,
      expected: expectedPayload(error, rules[code]),
      label: `${subsystem}:${code}`,
    };
  });
}

function expectedPayload(
  error: CodedError<string>,
  rule: ExpectedRule,
): Readonly<Record<string, unknown>> {
  return {
    code: error.code,
    message: error.message,
    ...(rule.nextAction === undefined ? {} : { next_action: rule.nextAction }),
    retryable: rule.retryable,
  };
}
