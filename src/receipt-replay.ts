import type { SkippedStableResponse } from "./evidence-policy.js";
import {
  ExtractCandidateSchema,
  type ExtractCandidate as DomainExtractCandidate,
} from "./domain-schemas.js";
import {
  computeMatchSetDigest,
  normalizePossibleMatchSets,
  type PossibleKnowledgeMatch,
  type PossibleMatchSet,
} from "./possible-match.js";
import {
  RequestIntegrityError,
  computeRequestSha256,
  issueRequestBoundToken,
  type ExtractRequest,
  type PhaseRequest,
} from "./request-integrity.js";

export type ExtractCandidate = DomainExtractCandidate;

export interface MergeDecisionRequiredStableResponse {
  readonly candidates: readonly ExtractCandidate[];
  readonly state: "merge_decision_required";
}

export type ExtractStableResponse =
  | MergeDecisionRequiredStableResponse
  | SkippedStableResponse;

export type { PossibleMatchBinding } from "./possible-match.js";

export interface MergeDecisionRequiredRuntimeResponse
  extends MergeDecisionRequiredStableResponse {
  readonly finalize_token: string;
  readonly match_set_digest: string;
  readonly possible_matches: readonly PossibleMatchSet<PossibleKnowledgeMatch>[];
}

export type ExtractRuntimeResponse =
  | MergeDecisionRequiredRuntimeResponse
  | SkippedStableResponse;

interface ReceiptBase {
  readonly jobId: string;
  readonly requestSha256: string;
  readonly submissionId: string;
}

export interface ExtractReceipt extends ReceiptBase {
  readonly phase: "extract";
  readonly stableResponse: ExtractStableResponse;
}

export interface FinalizeReceipt extends ReceiptBase {
  readonly phase: "finalize";
  readonly stableResponse: unknown;
}

export type Receipt = ExtractReceipt | FinalizeReceipt;

export interface ReceiptStore {
  find(phase: Receipt["phase"], submissionId: string): Receipt | undefined;
  findFinalizeByJob(jobId: string): FinalizeReceipt | undefined;
}

/** Minimal immutable receipt index used by the replay coordinator. */
export class InMemoryReceiptStore implements ReceiptStore {
  readonly #byJobFinalize = new Map<string, FinalizeReceipt>();
  readonly #bySubmission = new Map<string, Receipt>();

  add(receipt: Receipt): void {
    if (
      receipt.phase === "extract" &&
      receipt.stableResponse.state === "merge_decision_required" &&
      receipt.stableResponse.candidates.length === 0
    ) {
      throw new TypeError(
        "merge_decision_required receipts must contain a candidate",
      );
    }
    if (
      receipt.phase === "extract" &&
      receipt.stableResponse.state === "merge_decision_required"
    ) {
      for (const candidate of receipt.stableResponse.candidates) {
        ExtractCandidateSchema.parse(candidate);
      }
    }

    const key = receiptKey(receipt.phase, receipt.submissionId);
    if (this.#bySubmission.has(key)) {
      throw new TypeError(
        `Receipt already exists for ${receipt.phase}/${receipt.submissionId}`,
      );
    }

    this.#bySubmission.set(key, receipt);
    if (
      receipt.phase === "finalize" &&
      !this.#byJobFinalize.has(receipt.jobId)
    ) {
      this.#byJobFinalize.set(receipt.jobId, receipt);
    }
  }

  find(phase: Receipt["phase"], submissionId: string): Receipt | undefined {
    return this.#bySubmission.get(receiptKey(phase, submissionId));
  }

  findFinalizeByJob(jobId: string): FinalizeReceipt | undefined {
    return this.#byJobFinalize.get(jobId);
  }
}

export interface ReplayJob {
  readonly id: string;
  readonly leaseExpiresAt: string;
  readonly leaseGeneration: number;
  readonly status: "awaiting_finalize" | "finalized";
}

export interface ReceiptMissResult {
  readonly kind: "receipt_miss";
  readonly requestSha256: string;
}

export interface ExtractReplayResult {
  readonly kind: "extract_replay";
  readonly response: ExtractRuntimeResponse;
}

export interface FinalizeReplayResult {
  readonly kind: "finalize_replay";
  readonly response: unknown;
}

export type ReceiptReplayResult =
  | ExtractReplayResult
  | FinalizeReplayResult
  | ReceiptMissResult;

export type ReceiptReplayErrorCode =
  | "JOB_ALREADY_FINALIZED"
  | "RESUME_REQUIRED";

export class ReceiptReplayError extends Error {
  constructor(
    readonly code: ReceiptReplayErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ReceiptReplayError";
  }
}

type MaybePromise<T> = Promise<T> | T;

export interface ReceiptReplayDependencies {
  readonly loadJob: (jobId: string) => MaybePromise<ReplayJob | undefined>;
  readonly nextTokenId: () => string;
  readonly now: () => Date;
  readonly receiptStore: ReceiptStore;
  readonly searchPossibleMatches: (
    candidates: readonly ExtractCandidate[],
  ) => MaybePromise<readonly PossibleMatchSet<PossibleKnowledgeMatch>[]>;
  readonly tokenSecret: Uint8Array;
  readonly validateAuthorization: (request: PhaseRequest) => MaybePromise<void>;
}

/** Coordinates receipt-first phase replay and extract response rehydration. */
export class ReceiptReplayEngine {
  readonly #issuedFinalizeTokens = new Set<string>();

  constructor(readonly dependencies: ReceiptReplayDependencies) {}

  async replay(request: PhaseRequest): Promise<ReceiptReplayResult> {
    // Receipt lookup is deliberately the first request-dependent operation.
    const receipt = this.dependencies.receiptStore.find(
      request.phase,
      request.submission_id,
    );
    const requestSha256 = computeRequestSha256(request);

    if (receipt === undefined) {
      await this.dependencies.validateAuthorization(request);
      return { kind: "receipt_miss", requestSha256 };
    }

    if (receipt.requestSha256 !== requestSha256) {
      throw new RequestIntegrityError(
        "IDEMPOTENCY_KEY_REUSED",
        "Receipt submission_id is bound to a different request",
      );
    }

    if (request.phase === "finalize") {
      if (receipt.phase !== "finalize") {
        throw new TypeError("Receipt store returned the wrong phase");
      }
      return { kind: "finalize_replay", response: receipt.stableResponse };
    }

    if (receipt.phase !== "extract") {
      throw new TypeError("Receipt store returned the wrong phase");
    }
    return this.#rehydrateExtract(receipt, request);
  }

  async #rehydrateExtract(
    receipt: ExtractReceipt,
    request: ExtractRequest,
  ): Promise<ExtractReplayResult | FinalizeReplayResult> {
    if (receipt.stableResponse.state === "skipped") {
      return { kind: "extract_replay", response: receipt.stableResponse };
    }

    const job = await this.dependencies.loadJob(receipt.jobId);
    if (job?.id === receipt.jobId && job.status === "finalized") {
      const finalizeReceipt = this.dependencies.receiptStore.findFinalizeByJob(
        receipt.jobId,
      );
      if (finalizeReceipt !== undefined) {
        return {
          kind: "finalize_replay",
          response: finalizeReceipt.stableResponse,
        };
      }
      throw replayError(
        "JOB_ALREADY_FINALIZED",
        "The extract job has already been finalized",
      );
    }

    if (!hasValidLease(job, request, this.dependencies.now())) {
      throw replayError(
        "RESUME_REQUIRED",
        "The extract lease is missing, changed, or expired",
      );
    }

    const possibleMatches = normalizePossibleMatchSets(
      await this.dependencies.searchPossibleMatches(
        receipt.stableResponse.candidates,
      ),
    );
    const finalizeToken = issueRequestBoundToken(
      {
        kind: "finalize",
        requestSha256: receipt.requestSha256,
        tokenId: this.dependencies.nextTokenId(),
      },
      this.dependencies.tokenSecret,
    );
    if (this.#issuedFinalizeTokens.has(finalizeToken)) {
      throw new TypeError("nextTokenId must produce a fresh finalize token");
    }
    this.#issuedFinalizeTokens.add(finalizeToken);

    return {
      kind: "extract_replay",
      response: {
        candidates: receipt.stableResponse.candidates,
        finalize_token: finalizeToken,
        match_set_digest: computeMatchSetDigest(possibleMatches),
        possible_matches: possibleMatches,
        state: "merge_decision_required",
      },
    };
  }
}

function hasValidLease(
  job: ReplayJob | undefined,
  request: ExtractRequest,
  now: Date,
): job is ReplayJob {
  if (
    job === undefined ||
    job.id !== request.job_id ||
    job.status !== "awaiting_finalize" ||
    job.leaseGeneration !== request.lease_generation
  ) {
    return false;
  }

  const expiresAt = Date.parse(job.leaseExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

function receiptKey(phase: Receipt["phase"], submissionId: string): string {
  return `${phase}\u0000${submissionId}`;
}

function replayError(
  code: ReceiptReplayErrorCode,
  message: string,
): ReceiptReplayError {
  return new ReceiptReplayError(code, message);
}
