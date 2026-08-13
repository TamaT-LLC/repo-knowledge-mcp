import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  canonicalizeJson,
  compareCodeUnits,
  normalizeComments,
  normalizeSetArrays,
  sha256NormalizedJcs,
  sortAndDedupeStrings,
} from "../src/index.js";

describe("compareCodeUnits", () => {
  it("orders strings by unsigned UTF-16 code units", () => {
    const values = ["\ue000", "😀", "ä", "z", "a", "Å"];

    expect(values.sort(compareCodeUnits)).toEqual([
      "a",
      "z",
      "Å",
      "ä",
      "😀",
      "\ue000",
    ]);
    expect(compareCodeUnits("same", "same")).toBe(0);
  });
});

describe("sortAndDedupeStrings", () => {
  it("returns a sorted set without mutating its input", () => {
    const input = ["source-z", "source-a", "source-z"];

    expect(sortAndDedupeStrings(input)).toEqual(["source-a", "source-z"]);
    expect(input).toEqual(["source-z", "source-a", "source-z"]);
  });
});

describe("normalizeSetArrays", () => {
  it("normalizes every write-path set field recursively", () => {
    const input = {
      trustedActorIds: ["actor-z", "actor-a", "actor-z"],
      trust: { trustedLogins: ["zoe", "alice", "alice"] },
      candidates: {
        candidate_ids: ["candidate-2", "candidate-1", "candidate-2"],
        possible_match_ids: ["knowledge-b", "knowledge-a"],
      },
      sources: ["review", "issue", "review"],
      scope: ["global", "repository", "global"],
      evidence_comment_ids: ["comment-2", "comment-1", "comment-2"],
      orderedSteps: ["second", "first"],
    };

    expect(normalizeSetArrays(input)).toEqual({
      trustedActorIds: ["actor-a", "actor-z"],
      trust: { trustedLogins: ["alice", "zoe"] },
      candidates: {
        candidate_ids: ["candidate-1", "candidate-2"],
        possible_match_ids: ["knowledge-a", "knowledge-b"],
      },
      sources: ["issue", "review"],
      scope: ["global", "repository"],
      evidence_comment_ids: ["comment-1", "comment-2"],
      orderedSteps: ["second", "first"],
    });
    expect(input.trustedActorIds).toEqual(["actor-z", "actor-a", "actor-z"]);
  });

  it("rejects malformed set fields", () => {
    expect(() => normalizeSetArrays({ scope: ["global", 1] })).toThrow(
      "scope must be an array of strings",
    );
  });

  it("preserves special JSON keys without mutating object prototypes", () => {
    const input = JSON.parse(
      '{"__proto__":{"polluted":true},"scope":["repository"]}',
    ) as unknown;

    const normalized = normalizeSetArrays(input) as Record<string, unknown>;

    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(Object.hasOwn(normalized, "__proto__")).toBe(true);
    expect(canonicalizeJson(normalized)).toBe(
      '{"__proto__":{"polluted":true},"scope":["repository"]}',
    );
  });
});

describe("normalizeComments", () => {
  it("sorts by createdAt and then id without using localeCompare", () => {
    const comments = [
      { id: "ä", createdAt: "2026-08-06T00:00:01Z", body: "third" },
      { id: "z", createdAt: "2026-08-06T00:00:00Z", body: "second" },
      { id: "a", createdAt: "2026-08-06T00:00:00Z", body: "first" },
    ];
    const localeCompare = String.prototype.localeCompare;
    String.prototype.localeCompare = () => {
      throw new Error("localeCompare must not be called");
    };

    try {
      expect(normalizeComments(comments).map(({ body }) => body)).toEqual([
        "first",
        "second",
        "third",
      ]);
    } finally {
      String.prototype.localeCompare = localeCompare;
    }
  });
});

describe("JCS", () => {
  it("sorts object properties by code unit while preserving ordinary array order", () => {
    expect(canonicalizeJson({ z: 1, a: ["second", "first"] })).toBe(
      '{"a":["second","first"],"z":1}',
    );
  });

  it("rejects values outside I-JSON", () => {
    expect(() => canonicalizeJson(Number.NaN)).toThrow("non-finite");
    expect(() => canonicalizeJson("\ud800")).toThrow("lone UTF-16 surrogate");
    expect(() => canonicalizeJson(new Array(1))).toThrow(
      "does not support undefined",
    );
  });
});

describe("acceptance test 61", () => {
  it("keeps set arrays, comment order, and JCS digest identical across locale settings", () => {
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const moduleUrl = pathToFileURL(resolve(projectRoot, "dist/index.js")).href;
    const script = `
      import {
        normalizeComments,
        normalizeSetArrays,
        sha256Jcs,
      } from ${JSON.stringify(moduleUrl)};

      const sets = normalizeSetArrays({
        trustedActorIds: ["ä", "z", "a", "Å", "😀", "\\ue000", "ä"],
        sources: ["review", "issue", "review"],
        scope: ["repository", "global"],
        possible_match_ids: ["match-ä", "match-z", "match-a"],
        candidate_ids: ["candidate-2", "candidate-1", "candidate-2"],
        evidence_comment_ids: ["comment-ä", "comment-z", "comment-a"],
      });
      const comments = normalizeComments([
        { id: "ä", createdAt: "2026-08-06T00:00:00Z" },
        { id: "z", createdAt: "2026-08-06T00:00:00Z" },
        { id: "a", createdAt: "2026-08-05T23:59:59Z" },
      ]);
      console.log(JSON.stringify({ sets, comments, digest: sha256Jcs({ sets, comments }) }));
    `;
    const locales = [
      "C",
      "en_US.UTF-8",
      "sv_SE.UTF-8",
      "tr_TR.UTF-8",
      "ja_JP.UTF-8",
    ];

    const results = locales.map((locale) =>
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

    expect(new Set(results)).toHaveLength(1);
    expect(sha256NormalizedJcs({ sources: ["z", "a", "z"] })).toBe(
      sha256NormalizedJcs({ sources: ["a", "z"] }),
    );
  });
});
