import { describe, expect, it } from "vitest";

import {
  SENSITIVE_CONTENT_DETECTED,
  SensitiveContentFindingSchema,
  SensitiveContentTransmissionError,
  assertNoSensitiveContent,
  findSensitiveContent,
  mapMutationError,
} from "../src/experimental.js";

const SAMPLES = [
  {
    kind: "github_token",
    value: "ghp_0123456789abcdefghij0123456789",
  },
  {
    kind: "provider_api_key",
    value: "sk-ant-synthetic1234567890",
  },
  { kind: "aws_access_key_id", value: "AKIAIOSFODNN7EXAMPLE" },
  {
    kind: "private_key_block",
    value: "-----BEGIN SYNTHETIC PRIVATE KEY-----",
  },
  { kind: "email_address", value: "synthetic@example.com" },
] as const;

describe("sensitive-content scanner", () => {
  it.each(SAMPLES)("detects $kind without retaining its value", (sample) => {
    const findings = findSensitiveContent({ payload: sample.value });

    expect(findings).toEqual([{ kind: sample.kind, path: "$.payload" }]);
    expect(SensitiveContentFindingSchema.safeParse(findings[0]).success).toBe(
      true,
    );
    expect(JSON.stringify(findings)).not.toContain(sample.value);
  });

  it("redacts a sensitive object key from finding paths and mapped errors", () => {
    const secretKey = "ghp_abcdefghijklmnopqrstuvwxyz123456";
    const secretValue = "person@example.com";
    let rejection: SensitiveContentTransmissionError | undefined;

    try {
      assertNoSensitiveContent(
        { [secretKey]: secretValue },
        "provider_distillation_payload",
      );
    } catch (error) {
      if (error instanceof SensitiveContentTransmissionError) {
        rejection = error;
      } else {
        throw error;
      }
    }

    expect(rejection).toMatchObject({
      code: SENSITIVE_CONTENT_DETECTED,
      findings: [
        { kind: "github_token", path: "$.*" },
        { kind: "email_address", path: "$.*" },
      ],
    });
    const mapped = mapMutationError(rejection);
    expect(mapped).toMatchObject({
      code: SENSITIVE_CONTENT_DETECTED,
      details: {
        findings: [
          { kind: "github_token", path: "$.*" },
          { kind: "email_address", path: "$.*" },
        ],
      },
      next_action: expect.stringContaining("Remove or redact"),
      retryable: false,
    });
    expect(
      JSON.stringify({ mapped, rejection: String(rejection) }),
    ).not.toContain(secretKey);
    expect(
      JSON.stringify({ mapped, rejection: String(rejection) }),
    ).not.toContain(secretValue);
  });

  it.each([
    "alice@example.com",
    "bob.smith+tag@sub.example.co.jp",
    "contact: user@example.org.",
    "Signed-off-by: Alice <alice@example.com>",
    "user@163.com",
    "ssh root@10.0.0.5",
  ])("detects the email address in %s", (value) => {
    expect(findSensitiveContent({ body: value })).toEqual([
      { kind: "email_address", path: "$.body" },
    ]);
  });

  it.each([
    "https://raw.githubusercontent.com/brianc/node-postgres/pg@8.23.1/packages/x.js",
    "npx drizzle-kit@0.31.10 migrate",
    "https://docs.github.com/en/enterprise-server@3.11/rest",
    "pnpm add react@19.2.0",
    "pnpm add @scope/pkg@2.0.0-rc.1",
    "npm install typescript@5.7.0-beta",
    "uses: actions/checkout@v4.1.2",
    "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css",
  ])("does not treat the package@version in %s as an email", (value) => {
    expect(findSensitiveContent({ body: value })).toEqual([]);
  });

  it("scans long version-like input without quadratic backtracking", () => {
    const value = `${"a".repeat(30_000)}@${"1000.".repeat(6_000)}`;
    const started = performance.now();
    expect(findSensitiveContent({ body: value })).toEqual([]);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("leaves ordinary nested payloads unchanged", () => {
    expect(
      findSensitiveContent({
        candidates: [{ rule: "Keep failures observable." }],
        repository_context: { language: "TypeScript" },
      }),
    ).toEqual([]);
    expect(() =>
      assertNoSensitiveContent(
        { body: "Use a stable comparator." },
        "host_assisted_payload",
      ),
    ).not.toThrow();
  });
});
