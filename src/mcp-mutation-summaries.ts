import { type z } from "zod";

import type {
  AddKnowledgeResultSchema,
  IngestPrResultSchema,
  MutationToolSummarySchema,
  PrepareDistillationResultSchema,
  RecordOutcomeResultSchema,
  SubmitDistillationResultSchema,
  SyncRepoResultSchema,
  UpdateKnowledgeResultSchema,
} from "./mcp-mutation-schemas.js";

export interface MutationToolPresentation {
  readonly body: string;
  readonly summary: z.input<typeof MutationToolSummarySchema>;
}

export function summarizeIngest(
  result: z.infer<typeof IngestPrResultSchema>,
): MutationToolPresentation {
  return {
    body: `### Pull request ingested\n\nCreated **${result.jobs_created}** job(s); **${result.distilled}** distilled and **${result.pending}** pending.`,
    summary: {
      counts: {
        changed_threads: result.changed_threads,
        distilled: result.distilled,
        jobs_created: result.jobs_created,
        new_threads: result.new_threads,
        pending: result.pending,
        unchanged: result.unchanged,
        warnings: result.warnings.length,
      },
      next_action:
        result.pending > 0
          ? "If host-assisted distillation is explicitly enabled, call prepare_distillation; otherwise leave the jobs pending."
          : "Review any proposed knowledge through the admin CLI.",
      retryable: true,
    },
  };
}

export function summarizeSync(
  result: z.infer<typeof SyncRepoResultSchema>,
): MutationToolPresentation {
  const firstFailure = result.failures[0];
  const failureNote =
    firstFailure === undefined
      ? ""
      : ` Stopped at PR #${String(firstFailure.pr_number)} after the first failure.`;
  return {
    body: `### Repository synced\n\nDiscovered **${result.discovered}** updated pull request(s); **${result.ingested}** ingested and **${result.unchanged}** unchanged.${failureNote}`,
    summary: {
      counts: {
        discovered: result.discovered,
        failed: result.failed,
        ingested: result.ingested,
        jobs_created: result.jobs_created,
        unchanged: result.unchanged,
      },
      next_action:
        result.failed > 0
          ? "Call sync_repo again without since; the checkpoint stopped at the last contiguous success, so the failed pull request is retried first."
          : result.jobs_created > 0
            ? "If host-assisted distillation is explicitly enabled, call prepare_distillation; otherwise leave the jobs pending."
            : "No further action is required until new review activity arrives.",
      retryable: true,
    },
  };
}

export function summarizePrepare(
  result: z.infer<typeof PrepareDistillationResultSchema>,
): MutationToolPresentation {
  if (result.state === "disabled") {
    return {
      body: `### Host-assisted distillation disabled\n\nFound **${result.jobs.length}** pending job(s). Review content was not returned because explicit opt-in is incomplete.`,
      summary: {
        counts: {
          missing_settings: result.missing_settings.length,
          pending_jobs: result.jobs.length,
          review_content_items: 0,
        },
        next_action:
          "Enable both host-assisted settings, then call prepare_distillation again.",
        retryable: true,
      },
    };
  }
  return {
    body: `### Distillation prepared\n\nLeased **${result.jobs.length}** job(s); **${result.blocked_jobs.length}** blocked.`,
    summary: {
      counts: {
        blocked_jobs: result.blocked_jobs.length,
        leased_jobs: result.jobs.length,
      },
      next_action:
        result.jobs.length > 0
          ? "Distill each leased job and call submit_distillation with phase extract."
          : "No submission is required; ingest changed review content before preparing again.",
      retryable: false,
    },
  };
}

export function summarizeSubmit(
  result: z.infer<typeof SubmitDistillationResultSchema>,
): MutationToolPresentation {
  if ("state" in result && result.state === "skipped") {
    return {
      body: `### Distillation skipped\n\nRecorded skip reason \`${result.skip_reason}\`; no finalize call is required.`,
      summary: {
        counts: {
          staled_knowledge: result.staled_knowledge_ids.length,
          withdrawn_evidence: result.withdrawn_evidence_ids.length,
        },
        next_action: "No finalize call is required.",
        retryable: true,
      },
    };
  }
  if ("state" in result && result.state === "merge_decision_required") {
    return {
      body: `### Merge decisions required\n\nClassify **${result.candidates.length}** candidate(s), then submit the finalize phase.`,
      summary: {
        counts: {
          candidates: result.candidates.length,
          possible_matches: result.possible_matches.reduce(
            (count, matches) => count + matches.possible_matches.length,
            0,
          ),
        },
        next_action:
          "Classify every candidate, then call submit_distillation with phase finalize and the returned handle.",
        retryable: true,
      },
    };
  }
  const reviewCount =
    result.created_proposed.length + result.revision_proposals.length;
  return {
    body: `### Distillation finalized\n\nCreated **${result.created_active.length}** active rule(s) and **${result.created_proposed.length}** proposed rule(s), merged **${result.merged_evidence.length}** evidence item(s), and created **${result.revision_proposals.length}** revision proposal(s).`,
    summary: {
      counts: {
        created_active: result.created_active.length,
        created_proposed: result.created_proposed.length,
        merged_evidence: result.merged_evidence.length,
        revision_proposals: result.revision_proposals.length,
      },
      next_action:
        reviewCount > 0
          ? "Review proposed knowledge and revision proposals through the admin CLI."
          : null,
      retryable: true,
    },
  };
}

export function summarizeAdd(
  result: z.infer<typeof AddKnowledgeResultSchema>,
): MutationToolPresentation {
  return {
    body: `### Knowledge proposed\n\nCreated \`${result.id}\` in **proposed** state. A human must approve it in the admin CLI before it becomes active.`,
    summary: {
      counts: { created_proposed: 1 },
      next_action: "Review and approve the proposal through the admin CLI.",
      retryable: false,
    },
  };
}

export function summarizeUpdate(
  result: z.infer<typeof UpdateKnowledgeResultSchema>,
): MutationToolPresentation {
  return {
    body: `### Edit proposed\n\nCreated pending revision proposal \`${result.proposal_id}\` for \`${result.knowledge_id}\`. Canonical knowledge was not modified.`,
    summary: {
      counts: { revision_proposals: 1 },
      next_action:
        "Review and approve the revision proposal through the admin CLI.",
      retryable: false,
    },
  };
}

export function summarizeRecordOutcome(
  result: z.infer<typeof RecordOutcomeResultSchema>,
): MutationToolPresentation {
  const replayNote = result.replayed
    ? " Replayed the already-recorded event, so no counter changed."
    : "";
  return {
    body: `### Outcome recorded\n\nRecorded \`${result.outcome}\` for \`${result.knowledge_id}\` as event \`${result.event_id}\`.${replayNote}`,
    summary: {
      counts: {
        applied_count: result.applied_count,
        recorded_events: result.replayed ? 0 : 1,
        violation_count: result.violation_count,
      },
      next_action:
        "No further action is required; canonical projections now include this outcome.",
      retryable: true,
    },
  };
}

export function renderMutationContent(
  body: string,
  summary: z.output<typeof MutationToolSummarySchema>,
): string {
  const counts = Object.entries(summary.counts)
    .map(([name, value]) => `\`${name}\`: **${value}**`)
    .join(", ");
  return `${body}\n\nCounts: ${counts.length === 0 ? "none" : counts}.\n\nNext: ${summary.next_action ?? "No further action is required."}\n\nRetryable: **${summary.retryable ? "yes" : "no"}**.`;
}
