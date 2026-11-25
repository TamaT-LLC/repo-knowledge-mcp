import { describe, expect, it } from "vitest";

import {
  conversationMaskingVersion,
  redactConversationText,
} from "../src/conversation-redaction.js";
import {
  SensitiveContentBoundarySchema,
  assertNoSensitiveContent,
  findSensitiveContent,
} from "../src/sensitive-content.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl_x-y";

const RULES = [
  {
    name: "authorization header loses its whole value",
    input: "curl -H 'Authorization: Bearer abcdefghijklmnop1234'",
    output: "curl -H 'Authorization: [REDACTED]",
    kinds: { authorization_header: 1 },
  },
  {
    name: "secret assignment keeps its key",
    input: "export API_KEY=abcdefghijklmnopqrstuv now",
    output: "export API_KEY=[REDACTED] now",
    kinds: { generic_secret_assignment: 1 },
  },
  {
    name: "shared provider key",
    input: "use sk-ant-synthetic1234567890 here",
    output: "use [REDACTED] here",
    kinds: { provider_api_key: 1 },
  },
  {
    name: "private key body is removed with its header",
    input:
      "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK/+abc\n-----END RSA PRIVATE KEY-----\nafter",
    output: "[REDACTED]\nafter",
    kinds: { private_key_block: 1 },
  },
  {
    name: "connection string credentials keep the host",
    input: "postgres://alice:p@ss@db.example.com:5432/app",
    output: "postgres://[REDACTED]@db.example.com:5432/app",
    kinds: { connection_credentials: 1 },
  },
  {
    name: "jwt inside an assignment is removed entirely",
    input: `token=${JWT}`,
    output: "token=[REDACTED]",
    kinds: { jwt: 1 },
  },
  {
    name: "bearer token outside a header",
    input: "send bearer abcdefghijklmnopqrstu please",
    output: "send [REDACTED] please",
    kinds: { bearer_token: 1 },
  },
  {
    name: "long token alone or in a URL, but not as a path segment",
    input: `commit ${SHA}, https://x.io/cb/${SHA} and /tmp/${SHA}.json`,
    output: `commit [REDACTED], https://x.io/cb/[REDACTED] and /tmp/${SHA}.json`,
    kinds: { long_token: 2 },
  },
  {
    name: "home directories become ~",
    input: "open /Users/alice/repo/a.ts, /home/bob and /srv/home/x",
    output: "open ~/repo/a.ts, ~ and /srv/home/x",
    kinds: { home_path: 2 },
  },
  {
    name: "email address",
    input: "mail synthetic@example.com",
    output: "mail [REDACTED]",
    kinds: { email_address: 1 },
  },
] as const;

describe("conversation redaction", () => {
  it.each(RULES)("$name", ({ input, output, kinds }) => {
    const result = redactConversationText(input);
    expect(result.text).toBe(output);
    expect(
      Object.fromEntries(result.redactions.map((r) => [r.kind, r.count])),
    ).toEqual(kinds);
    // Masked output never trips the pre-send check, including Authorization.
    expect(findSensitiveContent({ text: result.text })).toEqual([]);
    expect(() =>
      assertNoSensitiveContent(
        { text: result.text },
        "conversation_provider_payload",
      ),
    ).not.toThrow();
    // Masking is idempotent, which the store relies on to reject raw text.
    expect(redactConversationText(result.text).text).toBe(result.text);
  });

  it("redacts a whole secret value and stays stable on a second pass", () => {
    expect(
      redactConversationText("password=abcdefghijklmnopqrst+/uvw== ok").text,
    ).toBe("password=[REDACTED] ok");
    // Truncating right after a path-segment run keeps the decision stable.
    expect(redactConversationText(`/tmp/${SHA}`).text).toBe(`/tmp/${SHA}`);
    expect(redactConversationText(`${SHA}/file`).text).toBe("[REDACTED]/file");
    for (const input of [
      "/srv/acme/home/bob/x",
      "acme/Users/bob and acme0123456789abcdef0123456789abcdef",
      "token=acmeabcdefghijklmnop+x",
    ]) {
      const once = redactConversationText(input, { redactTerms: ["acme"] });
      expect(
        redactConversationText(once.text, { redactTerms: ["acme"] }).text,
      ).toBe(once.text);
    }
  });

  it("replaces dictionary terms regardless of case and width", () => {
    const result = redactConversationText(
      "田中ＴＡＲＯ と Tanaka Taro, ACME と acme. REDACTED stays",
      { redactTerms: ["田中taro", "tanaka taro", "Ａｃｍｅ", "red"] },
    );
    expect(result.text).toBe(
      "[REDACTED] と [REDACTED], [REDACTED] と [REDACTED]. [REDACTED]ACTED stays",
    );
    expect(result.redactions).toEqual([{ kind: "redact_term", count: 5 }]);
    expect(
      redactConversationText("Authorization: Bearer abcdefghijklmnop1234", {
        redactTerms: ["red"],
      }).text,
    ).toBe("Authorization: [REDACTED]");
  });

  it("versions masking without exposing dictionary terms", () => {
    const key = Buffer.alloc(32, 7);
    const version = conversationMaskingVersion(key, ["Tanaka", "Acme"]);
    expect(version).toMatch(/^conv-mask-v1\+[0-9a-f]{16}$/u);
    expect(version.toLowerCase()).not.toContain("tanaka");
    expect(conversationMaskingVersion(key, ["acme", "ＴＡＮＡＫＡ"])).toBe(
      version,
    );
    expect(conversationMaskingVersion(key, ["acme"])).not.toBe(version);
    expect(conversationMaskingVersion(Buffer.alloc(32, 8), [])).not.toBe(
      conversationMaskingVersion(key, []),
    );
  });
});

describe("shared sensitive-content boundary", () => {
  it("adds conversation boundaries", () => {
    for (const boundary of [
      "conversation_provider_payload",
      "conversation_host_assisted_payload",
    ]) {
      expect(SensitiveContentBoundarySchema.parse(boundary)).toBe(boundary);
    }
  });

  it("keeps PR-path detection unchanged for conversation-only rules", () => {
    // Commit SHAs, JWT-like strings and prose bearer tokens are common in PR
    // review text and must not start failing the existing pre-send checks.
    expect(
      findSensitiveContent({
        body: `see ${SHA} ${JWT} bearer abcdefghijklmnopqrstu /Users/alice/x postgres://u:p@db/x`,
      }),
    ).toEqual([]);
    expect(
      findSensitiveContent({ body: "Authorization: Bearer [REDACTED]" }),
    ).toEqual([{ kind: "authorization_header", path: "$.body" }]);
  });
});
