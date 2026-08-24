import type {
  KnowledgeRevisionPatch,
  KnowledgeStatus,
} from "./domain-schemas.js";
import type { AdminPlaneService } from "./admin-plane-service.js";
import type { RepoKnowledgeDoctorLike } from "./doctor-service.js";
import type {
  KnowledgeMutationServiceResolutionInput,
  KnowledgeMutationServiceResolver,
} from "./mcp-mutation-tools.js";
import type {
  RepositoryStats,
  RepositoryStatsRequest,
} from "./stats-read-service.js";
import type {
  GuidedSetupPrompt,
  GuidedSetupRequest,
  GuidedSetupResult,
  SetupConfirmationRequest,
  SetupTextInputRequest,
} from "./setup-service.js";
import type {
  ReviewInboxRequest,
  ReviewInboxResult,
} from "./review-inbox-service.js";
import type { TerminalActivityUpdate } from "./terminal-progress.js";

export interface RepoKnowledgeCliIo {
  activity?(update: TerminalActivityUpdate): void;
  close?(): void;
  confirm?(request: SetupConfirmationRequest): Promise<boolean>;
  input?(request: SetupTextInputRequest): Promise<string>;
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  writeStderr(value: string): void;
  writeStdout(value: string): void;
}

export interface RepoKnowledgeServeRequest {
  readonly startupRepo?: string;
  readonly startupWorkspace?: string;
}

export interface CliDistillResult {
  readonly distilled: number;
  readonly pending: number;
  readonly reason?: string;
}

export interface CliKnowledgeSummary {
  readonly applied_count: number;
  readonly evidence_count: number;
  readonly id: string;
  readonly revision: number;
  readonly rule: string;
  readonly severity: string;
  readonly status: KnowledgeStatus;
  readonly violation_count: number;
}

export interface CliListKnowledgeRequest {
  readonly status?: KnowledgeStatus;
}

export interface CliListKnowledgeResult {
  readonly knowledge: readonly CliKnowledgeSummary[];
  readonly repo: string;
  readonly revision_proposals: readonly {
    readonly knowledge_id: string;
    readonly proposal_id: string;
    readonly updated_at: string;
  }[];
}

export interface CliReindexResult {
  readonly evidence: number;
  readonly jobs: number;
  readonly knowledge: number;
  readonly repo: string;
  readonly submissions: number;
}

export type CliRedistillRequest =
  | { readonly selector: "all" }
  | { readonly author: string; readonly selector: "author" }
  | { readonly selector: "failed" }
  | { readonly selector: "outdated" }
  | { readonly prompt_version: string; readonly selector: "prompt-version" };

export interface CliRedistillResult {
  readonly created_jobs: number;
  readonly reclassified_comments: number;
  readonly reset_jobs: number;
  readonly selected_threads: number;
  readonly unchanged: number;
}

export interface CliReconcileResult {
  readonly repo: string;
  readonly transaction_id: string | null;
  readonly unchanged: number;
  readonly written: number;
}

export interface CliAdminOperations {
  addActive: AdminPlaneService["addActive"];
  approve: AdminPlaneService["approve"];
  approveReviewedKnowledge: AdminPlaneService["approveReviewedKnowledge"];
  approveReviewedRevision: AdminPlaneService["approveReviewedRevision"];
  approveRevision: AdminPlaneService["approveRevision"];
  edit: AdminPlaneService["edit"];
  editReviewedKnowledge: AdminPlaneService["editReviewedKnowledge"];
  editReviewedRevision: AdminPlaneService["editReviewedRevision"];
  reject: AdminPlaneService["reject"];
  rejectReviewedKnowledge: AdminPlaneService["rejectReviewedKnowledge"];
  rejectReviewedRevision: AdminPlaneService["rejectReviewedRevision"];
}

export interface CliRepositoryOperations {
  readonly admin: CliAdminOperations;
  distill(): Promise<CliDistillResult>;
  listKnowledge(
    request?: CliListKnowledgeRequest,
  ): Promise<CliListKnowledgeResult>;
  /** Read-only unified queue consumed by the M3 batch review command. */
  reviewInbox(request?: ReviewInboxRequest): Promise<ReviewInboxResult>;
  reconcileDerivedMetadata(): Promise<CliReconcileResult>;
  redistill(request: CliRedistillRequest): Promise<CliRedistillResult>;
  reindex(): Promise<CliReindexResult>;
  /** Versioned read-only aggregation; canonical data is never modified. */
  stats(request?: RepositoryStatsRequest): Promise<RepositoryStats>;
}

export interface CliRepositoryOperationsResolver {
  resolve(
    input: KnowledgeMutationServiceResolutionInput,
  ): Promise<CliRepositoryOperations>;
}

export interface RunRepoKnowledgeCliOptions {
  readonly argv: readonly string[];
  readonly doctor: RepoKnowledgeDoctorLike;
  readonly io: RepoKnowledgeCliIo;
  readonly mutationServiceResolver: KnowledgeMutationServiceResolver;
  readonly operationsResolver: CliRepositoryOperationsResolver;
  serve(request: RepoKnowledgeServeRequest): Promise<void> | void;
  setup(
    request: GuidedSetupRequest,
    prompt: GuidedSetupPrompt,
  ): Promise<GuidedSetupResult>;
}

export type ParsedCliCommand =
  | { readonly kind: "help" }
  | {
      readonly json?: true;
      readonly kind: "setup";
      readonly request: GuidedSetupRequest;
    }
  | {
      readonly kind: "doctor";
      readonly selection: CliRepositorySelection;
    }
  | {
      readonly kind: "serve";
      readonly selection: CliRepositorySelection;
    }
  | {
      readonly kind: "sync";
      readonly selection: CliRepositorySelection;
      readonly since?: string;
    }
  | {
      readonly kind: "stats";
      readonly request: RepositoryStatsRequest;
      readonly selection: CliRepositorySelection;
    }
  | {
      readonly kind: "ingest";
      readonly prNumber: number;
      readonly selection: CliRepositorySelection;
    }
  | {
      readonly kind: "distill";
      readonly selection: CliRepositorySelection;
    }
  | {
      readonly kind: "list";
      readonly selection: CliRepositorySelection;
      readonly status?: KnowledgeStatus;
    }
  | {
      readonly kind: "review";
      readonly selection: CliRepositorySelection;
    }
  | {
      readonly kind: "reindex";
      readonly selection: CliRepositorySelection;
    }
  | {
      readonly kind: "redistill";
      readonly request: CliRedistillRequest;
      readonly selection: CliRepositorySelection;
    }
  | {
      readonly kind: "reconcile";
      readonly selection: CliRepositorySelection;
    }
  | {
      readonly kind: "export-bootstrap";
      readonly selection: CliRepositorySelection;
    }
  | {
      readonly id: string;
      readonly kind: "approve" | "reject";
      readonly selection: CliRepositorySelection;
    }
  | {
      readonly id: string;
      readonly kind: "edit";
      readonly patch: KnowledgeRevisionPatch;
      readonly selection: CliRepositorySelection;
    }
  | {
      readonly kind: "approve-revision";
      readonly proposalId: string;
      readonly selection: CliRepositorySelection;
    }
  | {
      readonly input: Parameters<AdminPlaneService["addActive"]>[0];
      readonly kind: "add-active";
      readonly selection: CliRepositorySelection;
    };

export interface CliRepositorySelection {
  readonly repo?: string;
  readonly workspacePath?: string;
}
