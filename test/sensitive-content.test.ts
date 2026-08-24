import { describe, expect, it } from "vitest";

import {
  SENSITIVE_CONTENT_DETECTED,
  SensitiveContentFindingSchema,
  SensitiveContentTransmissionError,
  assertNoSensitiveContent,
  findSensitiveContent,
  mapMutationError,
} from "../src/index.js";

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
      findings: [{ kind: "email_address", path: "$.*" }],
    });
    const mapped = mapMutationError(rejection);
    expect(mapped).toMatchObject({
      code: SENSITIVE_CONTENT_DETECTED,
      details: {
        findings: [{ kind: "email_address", path: "$.*" }],
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
