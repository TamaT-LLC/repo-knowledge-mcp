import { describe, expect, it } from "vitest";

import {
  GENERATED_CODE_EXAMPLE_MAX_CONTENT_CHARACTERS,
  KNOWLEDGE_CODE_EXAMPLE_MARKER_PREFIX,
  parseKnowledgeBodyCodeExample,
  renderKnowledgeBodyWithCodeExample,
  renderKnowledgeCodeExampleSection,
  type GeneratedCodeExample,
} from "../src/experimental.js";

const DETAIL = "Handle invoke failures explicitly.\n\nNever swallow errors.";

describe("knowledge code example canonical representation", () => {
  it("round-trips a rendered body back into the same detail and example", () => {
    const example = codeExample();

    const body = renderKnowledgeBodyWithCodeExample(DETAIL, example);
    const parsed = parseKnowledgeBodyCodeExample(body);

    expect(parsed.code_example).toEqual(example);
    expect(parsed.detail).toBe(DETAIL.trimEnd());
    expect(body.startsWith(DETAIL.trimEnd())).toBe(true);
    expect(body).toContain(
      `${KNOWLEDGE_CODE_EXAMPLE_MARKER_PREFIX}comment-1, comment-2 -->`,
    );
  });

  it("round-trips content containing backtick fences with a longer fence", () => {
    const example = codeExample({
      content: 'const block = "```markdown fences```";\nrender(block);',
    });

    const body = renderKnowledgeBodyWithCodeExample(DETAIL, example);
    const parsed = parseKnowledgeBodyCodeExample(body);

    expect(body).toContain("````typescript");
    expect(parsed.code_example).toEqual(example);
  });

  it("round-trips a body with a trailing newline added by serialization", () => {
    const body = `${renderKnowledgeBodyWithCodeExample(DETAIL, codeExample())}\n`;

    expect(parseKnowledgeBodyCodeExample(body).code_example).toEqual(
      codeExample(),
    );
  });

  it("returns the body unchanged when no example is present", () => {
    expect(renderKnowledgeBodyWithCodeExample(DETAIL)).toBe(DETAIL);
    expect(parseKnowledgeBodyCodeExample(DETAIL)).toEqual({
      code_example: null,
      detail: DETAIL,
    });
  });

  it("reads M1-era bodies without any migration marker as example-free", () => {
    const m1Body =
      "## 背景\nTauri 側の失敗が握り潰される。\n## 適用条件\n`invoke` 呼び出し箇所。\n";

    expect(parseKnowledgeBodyCodeExample(m1Body)).toEqual({
      code_example: null,
      detail: m1Body,
    });
  });

  it.each([
    [
      "a hand-edited marker without a fenced block",
      `${DETAIL}\n\n${KNOWLEDGE_CODE_EXAMPLE_MARKER_PREFIX}comment-1 -->\n\nprose instead of code`,
    ],
    [
      "an unterminated fence",
      `${DETAIL}\n\n${KNOWLEDGE_CODE_EXAMPLE_MARKER_PREFIX}comment-1 -->\n\n\`\`\`typescript\nconst x = 1;`,
    ],
    [
      "a mismatched closing fence length",
      `${DETAIL}\n\n${KNOWLEDGE_CODE_EXAMPLE_MARKER_PREFIX}comment-1 -->\n\n\`\`\`\`typescript\nconst x = 1;\n\`\`\``,
    ],
    [
      "an invalid language identifier",
      `${DETAIL}\n\n${KNOWLEDGE_CODE_EXAMPLE_MARKER_PREFIX}comment-1 -->\n\n\`\`\`Type Script\nconst x = 1;\n\`\`\``,
    ],
    [
      "an empty evidence comment list",
      `${DETAIL}\n\n${KNOWLEDGE_CODE_EXAMPLE_MARKER_PREFIX}, -->\n\n\`\`\`typescript\nconst x = 1;\n\`\`\``,
    ],
    [
      "prose after the closing fence",
      `${renderKnowledgeBodyWithCodeExample(DETAIL, codeExample())}\n\ntrailing prose`,
    ],
  ])("fails soft for %s and keeps the full body as detail", (_name, body) => {
    expect(parseKnowledgeBodyCodeExample(body)).toEqual({
      code_example: null,
      detail: body,
    });
  });

  it("fails soft when hand-edited content exceeds the schema limit", () => {
    const oversized = `${DETAIL}\n\n${KNOWLEDGE_CODE_EXAMPLE_MARKER_PREFIX}comment-1 -->\n\n\`\`\`typescript\n${"x".repeat(
      GENERATED_CODE_EXAMPLE_MAX_CONTENT_CHARACTERS + 1,
    )}\n\`\`\``;

    expect(parseKnowledgeBodyCodeExample(oversized).code_example).toBeNull();
  });

  it("parses only the last marker so quoted markers in the detail stay prose", () => {
    const quotingDetail = `${DETAIL}\n\nQuoted marker: ${KNOWLEDGE_CODE_EXAMPLE_MARKER_PREFIX}comment-9 -->`;
    const body = renderKnowledgeBodyWithCodeExample(
      quotingDetail,
      codeExample(),
    );

    const parsed = parseKnowledgeBodyCodeExample(body);

    expect(parsed.code_example).toEqual(codeExample());
    expect(parsed.detail).toBe(quotingDetail);
  });

  it("sorts and dedupes evidence comment IDs in the rendered marker", () => {
    const section = renderKnowledgeCodeExampleSection(
      codeExample({
        evidence_comment_ids: ["comment-2", "comment-1", "comment-2"],
      }),
    );

    expect(section).toContain(
      `${KNOWLEDGE_CODE_EXAMPLE_MARKER_PREFIX}comment-1, comment-2 -->`,
    );
  });
});

function codeExample(
  overrides: Partial<GeneratedCodeExample> = {},
): GeneratedCodeExample {
  return {
    content: "const result = await invoke();\nnotifyFailure(result);",
    evidence_comment_ids: ["comment-1", "comment-2"],
    generated_example: true,
    language: "typescript",
    ...overrides,
  };
}
