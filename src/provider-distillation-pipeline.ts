import {
  FinalizeStableResponseSchema,
  type ExtractCandidate,
  type FinalizeStableResponse,
} from "./domain-schemas.js";
import { createDomainId } from "./ids.js";
import type {
  MergeCandidateSearchResult,
  MergeCandidateSearchService,
} from "./merge-candidate-service.js";
import type {
  MergeClassificationResult,
  MergeRelationClassifier,
} from "./merge-classifier.js";
import type {
  CanonicalFinalizeService,
  CanonicalSkipFinalizeResult,
} from "./canonical-finalize-service.js";
import type {
  ProviderDistillationFailedResult,
  ProviderDistillationPendingResult,
  ProviderDistillationRunRequest,
  ProviderDistillationService,
} from "./provider-distillation-service.js";

export interface ProviderDistillationPipelineOptions {
  readonly classifier: MergeRelationClassifier;
  readonly extractor: Pick<ProviderDistillationService, "run">;
  readonly finalizer: Pick<CanonicalFinalizeService, "finalize" | "skip">;
  readonly nextCandidateId?: (timestamp: number) => string;
  readonly now?: () => Date;
  readonly search: Pick<MergeCandidateSearchService, "search">;
}

export interface ProviderDistillationPipelineFinalizedResult {
  readonly classification: MergeClassificationResult;
  readonly search: MergeCandidateSearchResult;
  readonly stable_response: FinalizeStableResponse;
  readonly state: "finalized";
}

export interface ProviderDistillationPipelineSkippedResult {
  readonly result: CanonicalSkipFinalizeResult;
  readonly state: "skipped";
}

export type ProviderDistillationPipelineResult =
  | ProviderDistillationFailedResult
  | ProviderDistillationPendingResult
  | ProviderDistillationPipelineFinalizedResult
  | ProviderDistillationPipelineSkippedResult;

/** Connects provider extraction, merge search/classification, and commit. */
export class ProviderDistillationPipeline {
  private readonly classifier: MergeRelationClassifier;
  private readonly extractor: Pick<ProviderDistillationService, "run">;
  private readonly finalizer: Pick<
    CanonicalFinalizeService,
    "finalize" | "skip"
  >;
  private readonly nextCandidateId: (timestamp: number) => string;
  private readonly now: () => Date;
  private readonly search: Pick<MergeCandidateSearchService, "search">;

  constructor(options: ProviderDistillationPipelineOptions) {
    this.classifier = options.classifier;
    this.extractor = options.extractor;
    this.finalizer = options.finalizer;
    this.search = options.search;
    this.now = options.now ?? (() => new Date());
    this.nextCandidateId =
      options.nextCandidateId ??
      ((timestamp) => createDomainId("candidate", timestamp));
  }

  async run(
    request: ProviderDistillationRunRequest,
  ): Promise<ProviderDistillationPipelineResult> {
    const extracted = await this.extractor.run(request);
    if (extracted.state !== "extracted") return extracted;

    if (extracted.output.candidates.length === 0) {
      return {
        result: await this.finalizer.skip({
          content_fingerprint: request.thread.contentFingerprint,
          distillation_key: request.thread.distillationKey,
          lease: extracted.lease,
          skip_reason: extracted.output.skip_reason!,
          thread_id: request.thread.threadId,
        }),
        state: "skipped",
      };
    }

    const timestamp = validTimestamp(this.now());
    const candidates: ExtractCandidate[] = extracted.output.candidates.map(
      (candidate) => ({
        candidate,
        candidate_id: this.nextCandidateId(timestamp),
      }),
    );
    const search = await this.search.search({
      candidates,
      threadId: request.thread.threadId,
    });
    const classification = await this.classifier.classify({
      candidates: search.candidates,
      possible_matches: search.possible_matches,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    const stableResponse = FinalizeStableResponseSchema.parse(
      await this.finalizer.finalize({
        candidates: search.candidates,
        content_fingerprint: request.thread.contentFingerprint,
        decisions: classification.decisions,
        distillation_key: request.thread.distillationKey,
        expected_match_set_digest: search.match_set_digest,
        lease: extracted.lease,
        provenance: extracted.provenance,
        thread_id: request.thread.threadId,
      }),
    );
    return {
      classification,
      search,
      stable_response: stableResponse,
      state: "finalized",
    };
  }
}

function validTimestamp(now: Date): number {
  const timestamp = now.getTime();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError("now() returned an invalid Date");
  }
  return timestamp;
}
