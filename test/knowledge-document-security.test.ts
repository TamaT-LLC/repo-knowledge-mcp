import { describe, expect, it } from "vitest";

import {
  KnowledgeStoreInvalidError,
  parseKnowledgeDocument,
  serializeKnowledgeDocument,
} from "../src/knowledge-document.js";

describe("knowledge document parser security", () => {
  it("round-trips strict YAML frontmatter without an executable parser", () => {
    const serialized = serializeKnowledgeDocument(
      "knowledge/example.md",
      {
        id: "knowledge_example",
        repo_id: "repo_example",
        revision: 1,
        schema_version: 1,
      },
      "Body\n",
    );

    expect(
      parseKnowledgeDocument("knowledge/example.md", serialized),
    ).toMatchObject({
      body: "Body\n",
      frontmatter: {
        id: "knowledge_example",
        repo_id: "repo_example",
        revision: 1,
        schema_version: 1,
      },
    });
  });

  it.each(["javascript", "js"])(
    "rejects a %s language suffix before parsing frontmatter",
    (language) => {
      const marker = `__repoKnowledgeExecuted_${language}`;
      const payload = [
        `---${language}`,
        `({ schema_version: 1, id: "id", repo_id: "repo", revision: 1, injected: (globalThis["${marker}"] = true) })`,
        "---",
        "Body",
      ].join("\n");

      expect(() =>
        parseKnowledgeDocument("knowledge/untrusted.md", payload),
      ).toThrow(KnowledgeStoreInvalidError);
      expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
    },
  );

  it("rejects an unterminated frontmatter block", () => {
    expect(() =>
      parseKnowledgeDocument(
        "knowledge/untrusted.md",
        "---\nschema_version: 1\nid: id\nrepo_id: repo\nrevision: 1\n",
      ),
    ).toThrow("frontmatter closing delimiter is missing");
  });
});
