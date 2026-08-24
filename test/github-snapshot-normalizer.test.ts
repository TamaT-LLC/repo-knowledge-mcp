import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  computeOutputSchemaDigest,
  computePromptDigest,
  createDomainId,
  normalizeGitHubPullRequestSnapshot,
  parseRepoKnowledgeConfig,
  type CompleteGitHubPullRequestSnapshot,
  type GitHubReviewActor,
  type GitHubReviewComment,
  type GitHubReviewSummary,
  type TrustConfig,
} from "../src/experimental.js";

const NOW = "2026-08-06T12:00:00.000Z";
const SNAPSHOT_ID = "snap_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TRANSACTION_ID = "txn_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const DEFAULT_TRUST = {
  trustedActorIds: ["U_trusted"],
};

describe("normalizeGitHubPullRequestSnapshot", () => {
  it("creates canonical raw records tied to one complete snapshot", () => {
    const result = normalizeSnapshot(completeSnapshot());

    expect(result.records.pullRequests).toHaveLength(1);
    expect(result.records.threadObservations).toHaveLength(2);
    expect(result.records.comments).toHaveLength(3);
    expect(result.records.pullRequests[0]).toMatchObject({
      payload: {
        base_ref_oid: "base-oid",
        head_ref_oid: "head-oid",
        name_with_owner: "owner/repository",
        observation_type: "pull_request",
        pr_number: 7,
        pull_request_id: "PR_pull_node",
        repo_id: "R_repo_node",
        snapshot_id: SNAPSHOT_ID,
      },
      record_type: "PullRequestObservation",
      recorded_at: NOW,
      schema_version: 1,
      transaction_id: TRANSACTION_ID,
    });
    for (const record of [
      ...result.records.pullRequests,
      ...result.records.threadObservations,
      ...result.records.comments,
    ]) {
      expect(record.record_id).toBe(record.payload.observation_id);
      expect(record.transaction_id).toBe(TRANSACTION_ID);
      expect(record.payload.snapshot_id).toBe(SNAPSHOT_ID);
    }

    const threadRecord = result.records.threadObservations.find(
      (record) => record.payload.thread_id === "thread-main",
    );
    expect(threadRecord).toMatchObject({
      payload: {
        comment_ids: ["comment-a", "comment-z"],
        is_outdated: true,
        is_resolved: true,
        path: "src/index.ts",
      },
      record_type: "ThreadObservation",
    });
    const normalizedComment = result.records.comments.find(
      (record) => record.payload.comment_id === "comment-a",
    );
    expect(normalizedComment).toMatchObject({
      payload: {
        actor: {
          actor_id: "U_trusted",
          actor_kind: "user",
          author_association: "MEMBER",
          login: "alice",
          provider: "human",
          trust: "trusted",
        },
        body: "First\nline",
        diff_hunk: "@@ -1\n+1",
      },
      record_type: "CommentObservation",
    });

    const thread = target(result, "thread-main");
    expect(thread.normalizedComments.map((comment) => comment.id)).toEqual([
      "comment-a",
      "comment-z",
    ]);
    expect(thread).toMatchObject({
      disposition: "distill",
      initialKnowledgeStatus: "proposed",
      isOutdated: true,
      isResolved: true,
      rawOnlyReason: null,
    });
    expect(thread.contentFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(thread.stateFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(thread.distillationInputDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(thread.distillationKey).toMatch(/^sha256:[a-f0-9]{64}$/u);

    const summary = target(result, "review-summary:review-1");
    expect(summary.path).toBeNull();
    expect(summary.normalizedComments).toEqual([
      expect.objectContaining({ id: "review-1", body: "Approved summary" }),
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("keeps fingerprints and digests independent of GraphQL order and CRLF", () => {
    const source = completeSnapshot({ reviewSummaries: [] });
    const reordered = withComments(source, [
      { ...source.threads[0]!.comments[1]!, body: "Second\nline" },
      { ...source.threads[0]!.comments[0]!, body: "First\nline" },
    ]);
    const localeCompare = String.prototype.localeCompare;
    String.prototype.localeCompare = () => {
      throw new Error("localeCompare must not be used");
    };

    try {
      const first = target(normalizeSnapshot(source), "thread-main");
      const second = target(normalizeSnapshot(reordered), "thread-main");
      expect(second.normalizedComments.map((comment) => comment.id)).toEqual([
        "comment-a",
        "comment-z",
      ]);
      expect(second.contentFingerprint).toBe(first.contentFingerprint);
      expect(second.distillationInputDigest).toBe(
        first.distillationInputDigest,
      );
      expect(second.distillationKey).toBe(first.distillationKey);
    } finally {
      String.prototype.localeCompare = localeCompare;
    }
  });

  it("separates content changes from resolved and outdated state changes", () => {
    const source = completeSnapshot({ reviewSummaries: [] });
    const baseline = target(normalizeSnapshot(source), "thread-main");
    const stateOnly = target(
      normalizeSnapshot({
        ...source,
        threads: [
          {
            ...source.threads[0]!,
            isOutdated: false,
            isResolved: false,
          },
        ],
      }),
      "thread-main",
    );
    expect(stateOnly.contentFingerprint).toBe(baseline.contentFingerprint);
    expect(stateOnly.stateFingerprint).not.toBe(baseline.stateFingerprint);

    const bodyChanged = target(
      normalizeSnapshot(
        withComments(source, [
          { ...source.threads[0]!.comments[0]!, body: "Changed" },
          source.threads[0]!.comments[1]!,
        ]),
      ),
      "thread-main",
    );
    const diffChanged = target(
      normalizeSnapshot(
        withComments(source, [
          {
            ...source.threads[0]!.comments[0]!,
            diffHunk: "@@ different",
          },
          source.threads[0]!.comments[1]!,
        ]),
      ),
      "thread-main",
    );
    const replyAdded = target(
      normalizeSnapshot(
        withComments(source, [
          ...source.threads[0]!.comments,
          comment({
            body: "A meaningful reply",
            createdAt: "2026-08-06T12:00:01.000Z",
            id: "comment-reply",
          }),
        ]),
      ),
      "thread-main",
    );
    expect(bodyChanged.contentFingerprint).not.toBe(
      baseline.contentFingerprint,
    );
    expect(diffChanged.contentFingerprint).not.toBe(
      baseline.contentFingerprint,
    );
    expect(replyAdded.contentFingerprint).not.toBe(baseline.contentFingerprint);
  });

  it("changes distillation keys for actor, association, prompt, schema, alias, and trust policy changes", () => {
    const source = completeSnapshot({ reviewSummaries: [] });
    const baseline = target(normalizeSnapshot(source), "thread-main");
    const first = source.threads[0]!.comments[0]!;
    const second = source.threads[0]!.comments[1]!;
    const actorChanged = target(
      normalizeSnapshot(
        withComments(source, [
          {
            ...first,
            author: { ...first.author!, login: "alice-renamed" },
          },
          second,
        ]),
      ),
      "thread-main",
    );
    const associationChanged = target(
      normalizeSnapshot(
        withComments(source, [
          { ...first, authorAssociation: "OWNER" },
          second,
        ]),
      ),
      "thread-main",
    );
    for (const changed of [actorChanged, associationChanged]) {
      expect(changed.contentFingerprint).toBe(baseline.contentFingerprint);
      expect(changed.distillationInputDigest).not.toBe(
        baseline.distillationInputDigest,
      );
      expect(changed.distillationKey).not.toBe(baseline.distillationKey);
    }

    const promptChanged = target(
      normalizeSnapshot(source, { promptDigest: computePromptDigest("v2") }),
      "thread-main",
    );
    const schemaChanged = target(
      normalizeSnapshot(source, {
        outputSchemaDigest: computeOutputSchemaDigest({ type: "array" }),
      }),
      "thread-main",
    );
    const aliasChanged = target(
      normalizeSnapshot(source, {
        trust: {
          sourceAliases: { alice: "other" },
          trustedActorIds: ["U_trusted"],
        },
      }),
      "thread-main",
    );
    const trustPolicyChanged = target(
      normalizeSnapshot(source, {
        trust: {
          trustedActorIds: ["U_trusted"],
          trustedLogins: ["unrelated-login"],
        },
      }),
      "thread-main",
    );
    expect(promptChanged.distillationInputDigest).toBe(
      baseline.distillationInputDigest,
    );
    expect(schemaChanged.distillationInputDigest).toBe(
      baseline.distillationInputDigest,
    );
    expect(trustPolicyChanged.distillationInputDigest).toBe(
      baseline.distillationInputDigest,
    );
    expect(aliasChanged.normalizedActors[0]?.provider).toBe("other");
    for (const changed of [
      promptChanged,
      schemaChanged,
      aliasChanged,
      trustPolicyChanged,
    ]) {
      expect(changed.distillationKey).not.toBe(baseline.distillationKey);
    }
  });

  it("keeps unknown bots raw-only and emits a deduplicated configuration warning", () => {
    const botActor = actor("Bot", "BOT_unknown", "review-helper[bot]");
    const source = completeSnapshot({
      comments: [
        comment({ author: botActor, authorAssociation: "NONE", id: "bot-a" }),
        comment({ author: botActor, authorAssociation: "NONE", id: "bot-z" }),
      ],
      reviewSummaries: [],
    });
    const rawOnly = normalizeSnapshot(source, { trust: {} });
    expect(target(rawOnly, "thread-main")).toMatchObject({
      disposition: "raw-only",
      initialKnowledgeStatus: null,
      rawOnlyReason: "unknown-bot",
    });
    expect(rawOnly.records.comments).toHaveLength(2);
    expect(rawOnly.records.comments[0]?.payload.actor).toMatchObject({
      actor_id: "BOT_unknown",
      actor_kind: "bot",
      login: "review-helper[bot]",
      provider: "other",
      trust: "unknown",
    });
    expect(rawOnly.warnings).toEqual([
      {
        actorId: "BOT_unknown",
        code: "UNKNOWN_BOT_RAW_ONLY",
        commentIds: ["bot-a", "bot-z"],
        configPath: "trust.aiReviewers",
        login: "review-helper[bot]",
        threadIds: ["thread-main"],
      },
    ]);

    const configured = normalizeSnapshot(source, {
      trust: {
        aiReviewers: { "review-helper[bot]": "greptile" },
      },
    });
    expect(target(configured, "thread-main")).toMatchObject({
      disposition: "distill",
      initialKnowledgeStatus: "proposed",
      rawOnlyReason: null,
    });
    expect(configured.records.comments[0]?.payload.actor).toMatchObject({
      provider: "greptile",
      trust: "trusted",
    });
    expect(configured.warnings).toEqual([]);
  });

  it("applies the external contributor policy and explicit actor trust", () => {
    const external = completeSnapshot({
      comments: [
        comment({
          author: actor("User", "U_external", "outside-user"),
          authorAssociation: "FIRST_TIME_CONTRIBUTOR",
        }),
      ],
      reviewSummaries: [],
    });
    expect(
      target(normalizeSnapshot(external, { trust: {} }), "thread-main"),
    ).toMatchObject({
      disposition: "raw-only",
      rawOnlyReason: "external-contributor",
    });
    expect(
      target(
        normalizeSnapshot(external, {
          trust: { externalContributors: "proposed" },
        }),
        "thread-main",
      ),
    ).toMatchObject({
      disposition: "distill",
      initialKnowledgeStatus: "proposed",
    });
    const explicitlyTrusted = normalizeSnapshot(external, {
      trust: {
        autoActivateTrustedHuman: true,
        trustedActorIds: ["U_external"],
      },
    });
    expect(target(explicitlyTrusted, "thread-main")).toMatchObject({
      disposition: "distill",
      initialKnowledgeStatus: "proposed",
    });
    expect(explicitlyTrusted.records.comments[0]?.payload.actor.trust).toBe(
      "trusted",
    );

    const trustedByLogin = normalizeSnapshot(external, {
      trust: {
        autoActivateTrustedHuman: true,
        trustedLogins: ["outside-user"],
      },
    });
    expect(target(trustedByLogin, "thread-main")).toMatchObject({
      disposition: "distill",
      initialKnowledgeStatus: "proposed",
    });
    expect(trustedByLogin.records.comments[0]?.payload.actor.trust).toBe(
      "trusted",
    );
  });

  it("filters empty, emoji-only, and CI boilerplate from fingerprints but retains raw observations", () => {
    const meaningful = comment({
      body: "Keep this review feedback",
      id: "meaningful",
    });
    const noisy = completeSnapshot({
      comments: [
        comment({ body: " \r\n", id: "empty" }),
        comment({ body: "👨‍💻 👍🏽 1️⃣", id: "emoji" }),
        comment({
          author: actor("Bot", "BOT_ci", "github-actions[bot]"),
          authorAssociation: "NONE",
          body: "CI build passed successfully",
          id: "ci-notice",
        }),
        meaningful,
      ],
      isOutdated: true,
      isResolved: true,
      reviewSummaries: [],
    });
    const result = normalizeSnapshot(noisy);
    const thread = target(result, "thread-main");
    expect(result.records.comments).toHaveLength(4);
    expect(thread.normalizedComments.map((comment) => comment.id)).toEqual([
      "meaningful",
    ]);
    expect(thread.excludedCommentIds).toEqual(["ci-notice", "emoji", "empty"]);
    expect(thread).toMatchObject({
      disposition: "distill",
      isOutdated: true,
      isResolved: true,
    });
    expect(result.warnings).toEqual([]);

    const meaningfulOnly = target(
      normalizeSnapshot(
        completeSnapshot({ comments: [meaningful], reviewSummaries: [] }),
      ),
      "thread-main",
    );
    expect(thread.contentFingerprint).toBe(meaningfulOnly.contentFingerprint);

    const allFiltered = target(
      normalizeSnapshot(
        completeSnapshot({
          comments: [comment({ body: "🎉", id: "only-emoji" })],
          reviewSummaries: [],
        }),
      ),
      "thread-main",
    );
    expect(allFiltered).toMatchObject({
      disposition: "filtered",
      initialKnowledgeStatus: null,
      normalizedComments: [],
    });
  });

  it("rejects inconsistent snapshots and duplicate canonical record IDs", () => {
    const source = completeSnapshot({ reviewSummaries: [] });
    expect(() =>
      normalizeSnapshot({
        ...source,
        snapshot: { ...source.snapshot, thread_ids: ["different-thread"] },
      }),
    ).toThrow("SNAPSHOT_INCONSISTENT");

    const duplicateId = createDomainId("observation");
    expect(() =>
      normalizeGitHubPullRequestSnapshot(normalizationRequest(source), {
        nextObservationId: () => duplicateId,
      }),
    ).toThrow("DUPLICATE_OBSERVATION_ID");
  });
});

describe("locale-independent fingerprint normalization", () => {
  it("produces identical content and input digests across locale settings", () => {
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const moduleUrl = pathToFileURL(
      resolve(projectRoot, "dist/experimental.js"),
    ).href;
    const script = `
      import {
        computeDistillationInputDigest,
        computeThreadContentFingerprint,
        normalizeComments,
      } from ${JSON.stringify(moduleUrl)};
      const comments = normalizeComments([
        { id: "ä", body: "third", createdAt: "2026-08-06T00:00:00Z", updatedAt: "2026-08-06T00:00:00Z" },
        { id: "z", body: "second", createdAt: "2026-08-06T00:00:00Z", updatedAt: "2026-08-06T00:00:00Z" },
        { id: "a", body: "first", createdAt: "2026-08-05T23:59:59Z", updatedAt: "2026-08-05T23:59:59Z" },
      ]);
      const actors = comments.map(({ id }) => ({
        actor_id: "actor-" + id,
        actor_kind: "user",
        authorAssociation: "MEMBER",
        login: "login-" + id,
        provider: "human",
        trust: "trusted",
      }));
      console.log(JSON.stringify({
        content: computeThreadContentFingerprint("thread", "src/index.ts", comments),
        input: computeDistillationInputDigest({
          normalizedActors: actors,
          normalizedComments: comments,
          path: "src/index.ts",
          repositoryContext: { language: "TypeScript" },
          threadId: "thread",
        }),
      }));
    `;
    const outputs = ["C", "sv_SE.UTF-8", "tr_TR.UTF-8", "ja_JP.UTF-8"].map(
      (locale) =>
        execFileSync(
          process.execPath,
          ["--input-type=module", "--eval", script],
          {
            cwd: projectRoot,
            encoding: "utf8",
            env: { ...process.env, LANG: locale, LC_ALL: locale },
          },
        ).trim(),
    );

    expect(new Set(outputs)).toHaveLength(1);
  });
});

interface SnapshotOptions {
  readonly comments?: readonly GitHubReviewComment[];
  readonly isOutdated?: boolean;
  readonly isResolved?: boolean;
  readonly reviewSummaries?: readonly GitHubReviewSummary[];
}

function completeSnapshot(
  options: SnapshotOptions = {},
): CompleteGitHubPullRequestSnapshot {
  const comments = options.comments ?? [
    comment({
      body: "First\r\nline",
      createdAt: "2026-08-06T11:59:00.000Z",
      diffHunk: "@@ -1\r+1",
      id: "comment-a",
    }),
    comment({
      body: "Second\nline",
      createdAt: "2026-08-06T11:59:00.000Z",
      id: "comment-z",
    }),
  ];
  const reviewSummaries = options.reviewSummaries ?? [reviewSummary()];
  return {
    pullRequest: {
      baseRefOid: "base-oid",
      headRefOid: "head-oid",
      id: "PR_pull_node",
      mergedAt: NOW,
      number: 7,
      title: "Complete snapshot",
    },
    repository: {
      id: "R_repo_node",
      nameWithOwner: "owner/repository",
    },
    reviewSummaries,
    snapshot: {
      complete: true,
      observed_at: NOW,
      pr_number: 7,
      repo_id: "R_repo_node",
      review_summary_ids: reviewSummaries.map((review) => review.id),
      snapshot_id: SNAPSHOT_ID,
      thread_ids: ["thread-main"],
    },
    threads: [
      {
        comments,
        id: "thread-main",
        isOutdated: options.isOutdated ?? true,
        isResolved: options.isResolved ?? true,
        path: "src/index.ts",
      },
    ],
  };
}

function comment(
  overrides: Partial<GitHubReviewComment> = {},
): GitHubReviewComment {
  return {
    author: actor("User", "U_trusted", "alice"),
    authorAssociation: "MEMBER",
    body: "Review feedback",
    createdAt: "2026-08-06T11:59:00.000Z",
    diffHunk: "@@ -1 +1 @@",
    id: "comment-default",
    updatedAt: "2026-08-06T11:59:30.000Z",
    url: "https://github.com/owner/repository/pull/7#discussion_r1",
    ...overrides,
  };
}

function reviewSummary(): GitHubReviewSummary {
  return {
    author: actor("User", "U_trusted", "alice"),
    authorAssociation: "MEMBER",
    body: "Approved summary",
    createdAt: "2026-08-06T11:58:00.000Z",
    id: "review-1",
    state: "APPROVED",
    submittedAt: "2026-08-06T11:58:00.000Z",
    syntheticThreadId: "review-summary:review-1",
    updatedAt: "2026-08-06T11:58:00.000Z",
    url: "https://github.com/owner/repository/pull/7#pullrequestreview-1",
  };
}

function actor(
  __typename: string,
  id: string,
  login: string,
): GitHubReviewActor {
  return { __typename, id, login };
}

function withComments(
  snapshot: CompleteGitHubPullRequestSnapshot,
  comments: readonly GitHubReviewComment[],
): CompleteGitHubPullRequestSnapshot {
  return {
    ...snapshot,
    threads: [{ ...snapshot.threads[0]!, comments }],
  };
}

interface NormalizeOptions {
  readonly outputSchemaDigest?: string;
  readonly promptDigest?: string;
  readonly repositoryContext?: unknown;
  readonly trust?: unknown;
}

function normalizeSnapshot(
  snapshot: CompleteGitHubPullRequestSnapshot,
  options: NormalizeOptions = {},
): ReturnType<typeof normalizeGitHubPullRequestSnapshot> {
  let timestamp = 1_775_649_600_000;
  return normalizeGitHubPullRequestSnapshot(
    normalizationRequest(snapshot, options),
    {
      nextObservationId: () => createDomainId("observation", timestamp++),
    },
  );
}

function normalizationRequest(
  snapshot: CompleteGitHubPullRequestSnapshot,
  options: NormalizeOptions = {},
): {
  readonly outputSchemaDigest: string;
  readonly promptDigest: string;
  readonly repositoryContext: unknown;
  readonly snapshot: CompleteGitHubPullRequestSnapshot;
  readonly transactionId: string;
  readonly trust: TrustConfig;
} {
  return {
    outputSchemaDigest:
      options.outputSchemaDigest ??
      computeOutputSchemaDigest({ properties: {}, type: "object" }),
    promptDigest: options.promptDigest ?? computePromptDigest("distill-v1\n"),
    repositoryContext: options.repositoryContext ?? {
      languages: ["TypeScript"],
    },
    snapshot,
    transactionId: TRANSACTION_ID,
    trust: parseRepoKnowledgeConfig({
      trust: options.trust ?? DEFAULT_TRUST,
    }).trust,
  };
}

function target(
  result: ReturnType<typeof normalizeGitHubPullRequestSnapshot>,
  threadId: string,
) {
  const value = result.threads.find((thread) => thread.threadId === threadId);
  if (value === undefined)
    throw new Error(`Missing normalized thread ${threadId}`);
  return value;
}
