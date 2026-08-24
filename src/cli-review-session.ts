import {
  KnowledgeRevisionPatchSchema,
  type KnowledgeRevisionPatch,
} from "./domain-schemas.js";
import type {
  AdminKnowledgeReviewBinding,
  AdminRevisionProposalReviewBinding,
} from "./admin-plane-service.js";
import {
  REPO_KNOWLEDGE_CLI_EXIT,
  RepoKnowledgeCliError,
} from "./cli-errors.js";
import { runCliActivity, safeDiagnosticMessage } from "./cli-diagnostics.js";
import {
  renderReviewInboxItem,
  renderReviewSessionComplete,
  renderReviewSessionPaused,
  type NextReviewItem,
} from "./cli-render.js";
import type {
  CliAdminOperations,
  CliRepositoryOperations,
  RepoKnowledgeCliIo,
} from "./cli-types.js";
import type { ReviewInboxItem } from "./review-inbox-service.js";

const REVIEW_INBOX_PAGE_LIMIT = 100;
const REVIEW_INBOX_READ_RETRIES = 2;
const REVIEW_REFRESH_ERROR_CODES: ReadonlySet<string> = new Set([
  "INVALID_ADMIN_STATE",
  "KNOWLEDGE_CONFLICT",
  "KNOWLEDGE_NOT_FOUND",
  "REVISION_PROPOSAL_CHANGED",
  "REVISION_PROPOSAL_NOT_FOUND",
  "REVISION_PROPOSAL_NOT_PENDING",
]);

type ReviewAction = "approve" | "edit" | "quit" | "reject" | "skip";

export function assertReviewTerminal(io: RepoKnowledgeCliIo): void {
  if (!io.stdinIsTTY || !io.stdoutIsTTY || io.input === undefined) {
    throw new RepoKnowledgeCliError(
      "CLI_TTY_REQUIRED",
      "review requires real TTY stdin and stdout",
      REPO_KNOWLEDGE_CLI_EXIT.failure,
    );
  }
}

export async function executeReviewSession(
  service: CliRepositoryOperations,
  io: RepoKnowledgeCliIo,
): Promise<number> {
  const skipped = new Set<string>();
  let edited = 0;
  let reloadItemKey: string | undefined;
  let resolved = 0;
  let displayed = false;

  try {
    for (;;) {
      const next = await runCliActivity(
        io,
        "review.load",
        displayed ? "Loading the next review item" : "Loading review items",
        async () => {
          if (reloadItemKey === undefined) {
            return nextReviewItem(service, skipped);
          }
          const preferredKey = reloadItemKey;
          reloadItemKey = undefined;
          return (
            (await reviewItemByKey(service, preferredKey)) ??
            (await nextReviewItem(service, skipped))
          );
        },
      );
      if (next === null) {
        const progress = { edited, resolved, skipped: skipped.size };
        io.writeStdout(
          displayed
            ? renderReviewSessionComplete(progress)
            : "Review inbox is empty.\n",
        );
        return REPO_KNOWLEDGE_CLI_EXIT.success;
      }
      displayed = true;
      io.writeStdout(
        renderReviewInboxItem(next, {
          edited,
          resolved,
          skipped: skipped.size,
        }),
      );
      const action = await promptReviewAction(io, next.item);
      if (action === "quit") {
        io.writeStdout(
          renderReviewSessionPaused({
            edited,
            resolved,
            skipped: skipped.size,
          }),
        );
        return REPO_KNOWLEDGE_CLI_EXIT.success;
      }
      if (action === "skip") {
        skipped.add(reviewItemKey(next.item));
        io.writeStdout("Skipped for this session; the item remains pending.\n");
        continue;
      }

      let patch: KnowledgeRevisionPatch | undefined;
      if (action === "edit") {
        patch = await promptReviewPatch(io, next.item);
        if (patch === undefined) {
          io.writeStdout("Edit cancelled; the item remains pending.\n");
          continue;
        }
      }

      try {
        await runCliActivity(
          io,
          `review.${action}`,
          reviewActionActivityLabel(action),
          () => applyReviewAction(service.admin, next.item, action, patch),
        );
      } catch (error) {
        if (!isReviewRefreshError(error)) throw error;
        reloadItemKey = reviewItemKey(next.item);
        io.writeStderr(
          `REVIEW_ITEM_CHANGED: ${safeDiagnosticMessage(
            error instanceof Error ? error.message : String(error),
          )}; reloading the latest inbox item.\n`,
        );
        continue;
      }

      if (action === "edit") {
        edited += 1;
        io.writeStdout(
          "Edited successfully; review the refreshed item before resolving it.\n",
        );
      } else {
        resolved += 1;
        io.writeStdout(
          `${action === "approve" ? "Approved" : "Rejected"} successfully.\n`,
        );
      }
    }
  } catch (error) {
    const termination = reviewInputTermination(error);
    if (termination === null) throw error;
    io.writeStdout(
      renderReviewSessionPaused({
        edited,
        resolved,
        skipped: skipped.size,
      }),
    );
    return termination;
  }
}

async function nextReviewItem(
  service: CliRepositoryOperations,
  skipped: ReadonlySet<string>,
): Promise<NextReviewItem | null> {
  return findReviewItem(
    service,
    (candidate) => !skipped.has(reviewItemKey(candidate)),
  );
}

async function reviewItemByKey(
  service: CliRepositoryOperations,
  key: string,
): Promise<NextReviewItem | null> {
  return findReviewItem(
    service,
    (candidate) => reviewItemKey(candidate) === key,
  );
}

async function findReviewItem(
  service: CliRepositoryOperations,
  select: (candidate: ReviewInboxItem) => boolean,
): Promise<NextReviewItem | null> {
  for (let attempt = 0; attempt <= REVIEW_INBOX_READ_RETRIES; attempt += 1) {
    let cursor: string | undefined;
    try {
      do {
        const page = await service.reviewInbox({
          ...(cursor === undefined ? {} : { cursor }),
          limit: REVIEW_INBOX_PAGE_LIMIT,
        });
        const item = page.items.find(select);
        if (item !== undefined) {
          return { item, repo: page.repo, totalCount: page.total_count };
        }
        cursor = page.next_cursor ?? undefined;
      } while (cursor !== undefined);
      return null;
    } catch (error) {
      const code = errorCode(error);
      if (
        code !== "REVIEW_INBOX_CURSOR_STALE" &&
        code !== "REVIEW_INBOX_PROJECTION_CHANGED"
      ) {
        throw error;
      }
    }
  }
  throw new RepoKnowledgeCliError(
    "CLI_REVIEW_UNSTABLE",
    "review inbox changed repeatedly while the session was reading it; retry the command",
    REPO_KNOWLEDGE_CLI_EXIT.failure,
  );
}

async function promptReviewAction(
  io: RepoKnowledgeCliIo,
  item: ReviewInboxItem,
): Promise<ReviewAction> {
  for (;;) {
    const answer = (
      await io.input!({
        id: `review.action.${reviewItemKey(item)}`,
        message: "Action ([a]pprove / [r]eject / [s]kip / [e]dit / [q]uit)",
      })
    )
      .trim()
      .toLocaleLowerCase("en-US");
    const action = reviewAction(answer);
    if (action !== null) return action;
    io.writeStderr(
      "REVIEW_ACTION_INVALID: enter approve, reject, skip, edit, or quit.\n",
    );
  }
}

function reviewAction(value: string): ReviewAction | null {
  switch (value) {
    case "a":
    case "approve":
      return "approve";
    case "e":
    case "edit":
      return "edit";
    case "q":
    case "quit":
      return "quit";
    case "r":
    case "reject":
      return "reject";
    case "s":
    case "skip":
      return "skip";
    default:
      return null;
  }
}

async function promptReviewPatch(
  io: RepoKnowledgeCliIo,
  item: ReviewInboxItem,
): Promise<KnowledgeRevisionPatch | undefined> {
  for (;;) {
    const field = (
      await io.input!({
        id: `review.edit-field.${reviewItemKey(item)}`,
        message: "Field [rule/detail/category/severity/scope] (or cancel)",
      })
    )
      .trim()
      .toLocaleLowerCase("en-US");
    if (field === "cancel" || field === "c") return undefined;
    if (!isReviewPatchField(field)) {
      io.writeStderr(
        "REVIEW_EDIT_FIELD_INVALID: choose rule, detail, category, severity, scope, or cancel.\n",
      );
      continue;
    }

    for (;;) {
      const value = await io.input!({
        id: `review.edit-value.${field}.${reviewItemKey(item)}`,
        message:
          field === "scope"
            ? 'New scope (JSON array, for example ["src/**"])'
            : `New ${field}`,
      });
      const patch = parseReviewPatch(field, value);
      if (patch !== null) return patch;
      io.writeStderr(
        `REVIEW_EDIT_VALUE_INVALID: ${field} does not accept that value.\n`,
      );
    }
  }
}

type ReviewPatchField = "category" | "detail" | "rule" | "scope" | "severity";

function isReviewPatchField(value: string): value is ReviewPatchField {
  return (
    value === "category" ||
    value === "detail" ||
    value === "rule" ||
    value === "scope" ||
    value === "severity"
  );
}

function parseReviewPatch(
  field: ReviewPatchField,
  rawValue: string,
): KnowledgeRevisionPatch | null {
  let value: unknown = rawValue.trim();
  if (field === "scope") {
    try {
      value = JSON.parse(rawValue) as unknown;
    } catch {
      return null;
    }
  }
  const parsed = KnowledgeRevisionPatchSchema.safeParse({ [field]: value });
  return parsed.success ? parsed.data : null;
}

async function applyReviewAction(
  admin: CliAdminOperations,
  item: ReviewInboxItem,
  action: Exclude<ReviewAction, "quit" | "skip">,
  patch: KnowledgeRevisionPatch | undefined,
): Promise<void> {
  if (item.kind === "knowledge") {
    const expected: AdminKnowledgeReviewBinding = {
      etag: item.etag,
      id: item.knowledge_id,
      revision: item.revision,
    };
    if (action === "approve") {
      await admin.approveReviewedKnowledge(expected);
    } else if (action === "reject") {
      await admin.rejectReviewedKnowledge(expected);
    } else {
      await admin.editReviewedKnowledge(expected, requiredReviewPatch(patch));
    }
    return;
  }

  const expected: AdminRevisionProposalReviewBinding = {
    knowledge: {
      etag: item.etag,
      id: item.knowledge_id,
      revision: item.revision,
    },
    proposalEtag: item.proposal_etag,
    proposalId: item.proposal_id,
  };
  if (action === "approve") {
    await admin.approveReviewedRevision(expected);
  } else if (action === "reject") {
    await admin.rejectReviewedRevision(expected);
  } else {
    await admin.editReviewedRevision(expected, requiredReviewPatch(patch));
  }
}

function requiredReviewPatch(
  patch: KnowledgeRevisionPatch | undefined,
): KnowledgeRevisionPatch {
  if (patch === undefined) {
    throw new TypeError("edit review action requires a validated patch");
  }
  return patch;
}

function reviewActionActivityLabel(
  action: Exclude<ReviewAction, "quit" | "skip">,
): string {
  switch (action) {
    case "approve":
      return "Approving the review item";
    case "edit":
      return "Saving changes to the review item";
    case "reject":
      return "Rejecting the review item";
  }
}

function reviewItemKey(item: ReviewInboxItem): string {
  return `${item.kind}:${item.item_id}`;
}

function isReviewRefreshError(error: unknown): boolean {
  const code = errorCode(error);
  return code !== null && REVIEW_REFRESH_ERROR_CODES.has(code);
}

function reviewInputTermination(error: unknown): number | null {
  const code = errorCode(error);
  if (code === "CLI_INPUT_ENDED") return REPO_KNOWLEDGE_CLI_EXIT.success;
  if (code === "CLI_INPUT_INTERRUPTED") return 130;
  return null;
}

function errorCode(error: unknown): string | null {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}
