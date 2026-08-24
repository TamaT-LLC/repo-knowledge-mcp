import { safeTerminalValue } from "./admin-plane-service.js";
import type { GuidedSetupResult } from "./setup-service.js";
import type { ReviewInboxItem } from "./review-inbox-service.js";

export interface ReviewSessionProgress {
  readonly edited: number;
  readonly resolved: number;
  readonly skipped: number;
}

export interface NextReviewItem {
  readonly item: ReviewInboxItem;
  readonly repo: string;
  readonly totalCount: number;
}

export function renderReviewInboxItem(
  next: NextReviewItem,
  progress: ReviewSessionProgress,
): string {
  const { item } = next;
  const lines = [
    "",
    `Review inbox · ${String(next.totalCount)} pending`,
    `Repository: ${safeTerminalText(next.repo)}`,
    `Session: ${String(progress.resolved)} resolved · ${String(progress.edited)} edited · ${String(progress.skipped)} skipped`,
    "",
    item.kind === "knowledge" ? "Candidate rule" : "Revision proposal",
    `  ${safeTerminalText(item.rule)}`,
    "",
    "Why this may be reusable",
    `  ${safeTerminalText(item.detail) || "—"}`,
    "",
    "Applies to",
    ...renderReviewScopes(item.scope),
    `  Category: ${safeTerminalText(item.category)} · Severity: ${safeTerminalText(item.severity)}`,
    `  Sources: ${terminalList(item.sources)} · Trust: ${terminalList(item.trust_classes)}`,
  ];

  if (item.kind === "revision_proposal") {
    lines.push(
      "",
      "Proposed changes",
      `  ${safeTerminalValue(item.proposal_patch)}`,
    );
  }

  lines.push("", "Evidence", ...renderReviewEvidence(item));
  if (item.possible_matches.length > 0) {
    lines.push(
      "",
      "Possible existing matches",
      ...item.possible_matches.map(
        (match) =>
          `  - ${safeTerminalText(match.rule)} · ${safeTerminalText(match.severity)} · ${terminalList(match.scope)} · ${safeTerminalText(match.id)}`,
      ),
    );
  }
  if (item.related_ids.length > 0) {
    lines.push("", `Related rules: ${terminalList(item.related_ids)}`);
  }
  lines.push(
    "",
    item.kind === "knowledge"
      ? `Metadata: candidate · ${safeTerminalText(item.status)} · revision ${String(item.revision)} · ${safeTerminalText(item.knowledge_id)}`
      : `Metadata: revision · ${safeTerminalText(item.status)} · target ${safeTerminalText(item.knowledge_id)} · proposal ${safeTerminalText(item.item_id)} · revision ${String(item.revision)}`,
    `Origin: ${safeTerminalValue(item.origin)}`,
    "",
  );
  return `${lines.join("\n")}\n`;
}

function renderReviewScopes(scope: readonly string[]): string[] {
  return scope.length === 0
    ? ["  - repository-wide"]
    : scope.map((pattern) => `  - ${safeTerminalText(pattern)}`);
}

function renderReviewEvidence(item: ReviewInboxItem): string[] {
  if (item.evidence.length === 0) return ["  - No attached evidence"];
  return item.evidence.flatMap((entry) => {
    const actors = entry.actors
      .map((actor) => {
        const name = actor.login ?? "unknown actor";
        return `${safeTerminalText(name)} (${safeTerminalText(actor.provider)}, ${safeTerminalText(actor.trust)})`;
      })
      .join(", ");
    return [
      `  - ${actors} · ${terminalList(entry.sources)} · ${safeTerminalText(entry.status)}`,
      ...(entry.url === undefined
        ? []
        : [`    ${safeTerminalText(entry.url)}`]),
    ];
  });
}

function terminalList(values: readonly string[]): string {
  return values.length === 0
    ? "none"
    : values.map((value) => safeTerminalText(value)).join(", ");
}

export function safeTerminalText(value: string): string {
  return safeTerminalValue(value).slice(1, -1);
}

export function renderGuidedSetupSummary(result: GuidedSetupResult): string {
  const sync = result.initial_sync.summary;
  const routes = [
    result.transmission.provider ? "provider on" : "provider off",
    result.transmission.host_assisted
      ? "host-assisted on"
      : "host-assisted off",
  ].join(" · ");
  const trust =
    result.trust.selected.length === 0
      ? `0 selected this run · ${String(result.trust.candidates)} candidate(s) observed`
      : `${String(result.trust.selected.length)} selected this run · ${String(result.trust.candidates)} candidate(s) observed`;
  const status = setupStatusLine(result);
  const next = setupNextActions(result);
  const repository = safeTerminalText(result.repository.name);
  return `${[
    "",
    "Setup complete",
    "",
    `Repository  ${repository}`,
    `Workspace   ${result.repository.workspace_path === null ? "not registered" : safeTerminalText(result.repository.workspace_path)}`,
    `Storage     ${safeTerminalText(result.repository.storage_path)}`,
    `Sync        ${String(sync.discovered)} found · ${String(sync.ingested)} imported · ${String(sync.unchanged)} unchanged · ${String(sync.jobs_created)} job(s) queued`,
    `Health      ${String(result.doctor.pass)} passed · ${String(result.doctor.warn)} warnings · ${String(result.doctor.fail)} failed`,
    `Privacy     ${routes}`,
    `Trust       ${trust}`,
    "",
    "Status",
    `  ${status}`,
    "",
    "Next",
    ...next.map((action, index) => `  ${String(index + 1)}. ${action}`),
    "",
    `Machine-readable result: repo-knowledge setup ${repository} --json`,
    "",
  ].join("\n")}`;
}

function setupStatusLine(result: GuidedSetupResult): string {
  const jobs = result.initial_sync.summary.jobs_created;
  if (
    jobs > 0 &&
    !result.transmission.provider &&
    !result.transmission.host_assisted
  ) {
    return (
      `Local sync is ready. ${String(jobs)} new distillation job(s) are queued; ` +
      "no model transmission route is enabled."
    );
  }
  if (jobs > 0) {
    return `Local sync is ready. ${String(jobs)} new distillation job(s) are queued for the enabled route.`;
  }
  return "Local sync is ready and this run found no new distillation work.";
}

function setupNextActions(result: GuidedSetupResult): string[] {
  const repository = safeTerminalText(result.repository.name);
  const actions = [
    `Inspect active rules and pending jobs: repo-knowledge stats ${repository}`,
  ];
  if (result.transmission.host_assisted) {
    actions.push(
      "Ask the connected MCP host to process one pending job with prepare_distillation and submit_distillation.",
    );
  } else if (result.transmission.provider) {
    actions.push(`Process provider jobs: repo-knowledge distill ${repository}`);
  } else if (result.initial_sync.summary.jobs_created > 0) {
    actions.push(
      "To distill with a Claude/Codex subscription, review and enable both host-assisted consent settings, then ask the MCP host to process one job.",
    );
  }
  actions.push(
    `Review generated candidates when available: repo-knowledge review ${repository}`,
  );
  return actions;
}

export function renderReviewSessionComplete(
  progress: ReviewSessionProgress,
): string {
  if (progress.skipped > 0) {
    return renderReviewSessionPaused(progress);
  }
  return `Review inbox complete: ${String(progress.resolved)} resolved, ${String(progress.edited)} edit(s).\n`;
}

export function renderReviewSessionPaused(
  progress: ReviewSessionProgress,
): string {
  return (
    `Review session paused: ${String(progress.resolved)} resolved, ` +
    `${String(progress.edited)} edit(s), ${String(progress.skipped)} skipped; ` +
    "unresolved items remain available on the next run.\n"
  );
}
