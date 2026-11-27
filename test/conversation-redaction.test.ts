import { describe, expect, it } from "vitest";

import {
  CONVERSATION_MASKING_RULES_VERSION,
  computeConversationMaskingVersion,
  normalizeRedactTerms,
  redactConversationText,
  truncateMaskedText,
} from "../src/conversation-redaction.js";
import {
  SensitiveContentBoundarySchema,
  SensitiveContentKindSchema,
  assertNoSensitiveContent,
  findSensitiveContent,
} from "../src/sensitive-content.js";

const KEY = Buffer.alloc(32, 7);
const COMMIT_SHA = "3f2a9c1e0b7d4a6f8e2c5b1a9d3f7e6c4b2a1d0e";

/** Rule table: input, expected masked text, expected kinds and counts. */
const RULES = [
  {
    name: "Authorization header with a bearer value",
    input: 'curl -H "Authorization: Bearer abc.def-123456" https://x.test',
    output: 'curl -H "Authorization: [REDACTED]" https://x.test',
    redactions: [{ count: 1, kind: "authorization_header" }],
  },
  {
    name: "Authorization header with a basic value",
    input: "authorization:Basic dXNlcjpwYXNzd29yZA==",
    output: "authorization:[REDACTED]",
    redactions: [{ count: 1, kind: "authorization_header" }],
  },
  {
    name: "Authorization header with a bare token",
    input: "Authorization: 0123456789abcdefXYZ",
    output: "Authorization: [REDACTED]",
    redactions: [{ count: 1, kind: "authorization_header" }],
  },
  {
    name: "Bearer token outside a header",
    input: "use bearer abc.DEF_123-xyz to call it",
    output: "use [REDACTED] to call it",
    redactions: [{ count: 1, kind: "bearer_token" }],
  },
  {
    name: "JWT",
    input: "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl ok",
    output: "token [REDACTED] ok",
    redactions: [{ count: 1, kind: "jwt" }],
  },
  {
    name: "long alphanumeric run (commit SHA in prose)",
    input: `commit ${COMMIT_SHA} looks good`,
    output: "commit [REDACTED] looks good",
    redactions: [{ count: 1, kind: "long_token" }],
  },
  {
    name: "home directory paths on macOS and Linux",
    input: "open /Users/alice/repo/app, then cd /home/bob and ~/x",
    output: "open ~/repo/app, then cd ~ and ~/x",
    redactions: [{ count: 2, kind: "home_directory_path" }],
  },
  {
    name: "account names in Claude Code's encoded project directories",
    input:
      "see ~/.claude/projects/-Users-alice-repos-secret/memory and /private/tmp/claude-501/-home-bob--claude/x",
    output:
      "see ~/.claude/projects/-Users-[REDACTED]-repos-secret/memory and /private/tmp/claude-501/-home-[REDACTED]--claude/x",
    redactions: [{ count: 2, kind: "home_directory_path" }],
  },
  {
    name: "an armored PGP secret key, through its END line or to the end",
    input:
      "key:\n-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF0\n-----END PGP PRIVATE KEY BLOCK-----\nok, and -----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOY",
    output: "key:\n[REDACTED]\nok, and [REDACTED]",
    redactions: [{ count: 2, kind: "private_key_block" }],
  },
  {
    name: "connection string credentials",
    input: "db postgres://admin:s3cr3t@db.example.test:5432/app",
    output: "db postgres://[REDACTED]@db.example.test:5432/app",
    redactions: [{ count: 1, kind: "connection_string_credentials" }],
  },
  {
    name: "password-only connection string",
    input: "redis://:hunter2@cache.example.test",
    output: "redis://[REDACTED]@cache.example.test",
    redactions: [{ count: 1, kind: "connection_string_credentials" }],
  },
  {
    name: "secret assignment keeps the key name",
    input: 'API_KEY="abcdefghijklmnop1234!!" next',
    output: 'API_KEY="[REDACTED]" next',
    redactions: [{ count: 1, kind: "generic_secret_assignment" }],
  },
  {
    name: "secret assignment with a colon",
    input: "password: abcdefghijklmnopqrstu",
    output: "password: [REDACTED]",
    redactions: [{ count: 1, kind: "generic_secret_assignment" }],
  },
  {
    name: "email and provider key",
    input: "mail alice@example.com, key sk-ant-abcdefghijklmn",
    output: "mail [REDACTED], key [REDACTED]",
    redactions: [
      { count: 1, kind: "email_address" },
      { count: 1, kind: "provider_api_key" },
    ],
  },
  {
    name: "GitHub, Slack, AWS and Google tokens",
    input:
      "ghp_0123456789abcdefghij0123456789 xoxb-1234567890-abc AKIAIOSFODNN7EXAMPLE AIzaSyA0123456789abcdefghijklmnopqrstuv",
    output: "[REDACTED] [REDACTED] [REDACTED] [REDACTED]",
    redactions: [
      { count: 1, kind: "aws_access_key_id" },
      { count: 1, kind: "github_token" },
      { count: 1, kind: "google_api_key" },
      { count: 1, kind: "slack_token" },
    ],
  },
  {
    name: "private key block through its END line",
    input:
      "key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow1234\nabcd\n-----END RSA PRIVATE KEY-----\nafter",
    output: "key:\n[REDACTED]\nafter",
    redactions: [{ count: 1, kind: "private_key_block" }],
  },
  {
    name: "quoted Authorization header in JSON",
    input: '{"Authorization": "Basic dXNlcjpwYXNzd29yZA=="}',
    output: '{"Authorization": "[REDACTED]"}',
    redactions: [{ count: 1, kind: "authorization_header" }],
  },
  {
    name: "quoted Authorization header in Python",
    input: "{'authorization': 'Basic dXNlcjpwYXNz'}",
    output: "{'authorization': '[REDACTED]'}",
    redactions: [{ count: 1, kind: "authorization_header" }],
  },
  {
    name: "Authorization header with a quoted token",
    input: "Authorization: Bearer 'abcdefghijklmnopqrstu'",
    output: "Authorization: [REDACTED]'",
    redactions: [{ count: 1, kind: "authorization_header" }],
  },
  {
    name: "Authorization header with the token on the next line",
    input: "Authorization: Bearer\n  abcdefghijklmnop1234\nnext line",
    output: "Authorization: [REDACTED]\nnext line",
    redactions: [{ count: 1, kind: "authorization_header" }],
  },
  {
    name: "Basic credentials outside a header",
    input: "send basic dXNlcjpwYXNz to it",
    output: "send [REDACTED] to it",
    redactions: [{ count: 1, kind: "basic_credentials" }],
  },
  {
    name: "secret assignments with prefixed key names",
    input:
      'DB_PASSWORD=hunter2hunter2hunter2 AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY "client_secret": "GOCSPX-1a2b3c4d5e6f7g8h" access_token=ya29.a0AfH6SMBx-abc_def MY_API_TOKEN=abcdefghijklmnopqrstuvwx',
    output:
      'DB_PASSWORD=[REDACTED] AWS_SECRET_ACCESS_KEY=[REDACTED] "client_secret": "[REDACTED]" access_token=[REDACTED] MY_API_TOKEN=[REDACTED]',
    redactions: [{ count: 5, kind: "generic_secret_assignment" }],
  },
  {
    name: "home paths in any case and on Windows",
    input: "see /users/alice/repo and C:\\Users\\bob\\repo",
    output: "see ~/repo and ~\\repo",
    redactions: [{ count: 2, kind: "home_directory_path" }],
  },
  {
    name: "a private key pasted without its END line",
    input:
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nMzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDu+\nthanks",
    output: "[REDACTED]",
    redactions: [{ count: 1, kind: "private_key_block" }],
  },
  {
    name: "an encrypted private key pasted without its END line",
    input:
      "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,3F17\n\nMIIEpAIBAAKCAQ+Ax8uL1kz9W/Q3h0\nSkqP2N8vHrJ3m/0bXwZ5aLcY+4hT",
    output: "[REDACTED]",
    redactions: [{ count: 1, kind: "private_key_block" }],
  },
  {
    name: "a home path under WSL",
    input: "cd /mnt/c/Users/alice/repo",
    output: "cd ~/repo",
    redactions: [{ count: 1, kind: "home_directory_path" }],
  },
  {
    name: "a Windows home path right after a masked token",
    input: "eyJabc.def.ghiC:\\Users\\bob\\x",
    output: "[REDACTED]~\\x",
    redactions: [
      { count: 1, kind: "home_directory_path" },
      { count: 1, kind: "jwt" },
    ],
  },
  {
    name: "a Windows home path whose account name has a space",
    input: "open C:\\Users\\John Smith\\project",
    output: "open ~\\project",
    redactions: [{ count: 1, kind: "home_directory_path" }],
  },
  {
    name: "two home directories in a row",
    input: "/Users/bob/home/alice/x",
    output: "~/x",
    redactions: [{ count: 1, kind: "home_directory_path" }],
  },
  {
    name: "a connection-string password with a slash",
    input: "redis://:sec/ret123@cache.example.test",
    output: "redis://[REDACTED]@cache.example.test",
    redactions: [{ count: 1, kind: "connection_string_credentials" }],
  },
  {
    name: "a Windows home path followed by prose",
    input: "I put it in C:\\Users\\bob and the build fails",
    output: "I put it in ~ and the build fails",
    redactions: [{ count: 1, kind: "home_directory_path" }],
  },
  {
    name: "Authorization headers with short or placeholder credentials",
    input: "Authorization: Bearer abc123\nauthorization: Bearer $TOKEN",
    output: "Authorization: [REDACTED]\nauthorization: [REDACTED]",
    redactions: [{ count: 2, kind: "authorization_header" }],
  },
  {
    name: "a connection-string password with a raw @",
    input: "use postgres://admin:p@ss@localhost:5432/db now",
    output: "use postgres://[REDACTED]@localhost:5432/db now",
    redactions: [{ count: 1, kind: "connection_string_credentials" }],
  },
  {
    name: "a home path that ends a sentence",
    input: "see /home/bob. Then /Users/john.doe/x!",
    output: "see ~. Then ~/x!",
    redactions: [{ count: 2, kind: "home_directory_path" }],
  },
  {
    name: "an Authorization header whose value is already a placeholder",
    input: "Authorization: Bearer [REDACTED]",
    output: "Authorization: [REDACTED][REDACTED]",
    redactions: [{ count: 1, kind: "authorization_header" }],
  },
  {
    name: "a Windows home path with escaped backslashes",
    input: '"cwd": "C:\\\\Users\\\\bob\\\\repo"',
    output: '"cwd": "~\\\\repo"',
    redactions: [{ count: 1, kind: "home_directory_path" }],
  },
  {
    name: "home directories under /var/home and /export/home",
    input: "cd /var/home/alice/repo; ls /export/home/bob",
    output: "cd ~/repo; ls ~",
    redactions: [{ count: 2, kind: "home_directory_path" }],
  },
  {
    name: "home paths after a flag and under macOS volumes",
    input:
      "gcc -I/home/bob/include /System/Volumes/Data/Users/bob/x /Volumes/Ext/Users/carol /private/var/home/dan",
    output: "gcc -I~/include ~/x ~ ~",
    redactions: [{ count: 4, kind: "home_directory_path" }],
  },
  {
    name: "a secret written right after a literal placeholder",
    input: "password: [REDACTED]abcdefghijklmnopqrstu",
    output: "password: [REDACTED][REDACTED]",
    redactions: [{ count: 1, kind: "generic_secret_assignment" }],
  },
] as const;

/** Text that must stay as-is: the rules are not over-broad. */
const UNCHANGED = [
  "the bearer token is fine",
  `see https://github.com/o/r/commit/${COMMIT_SHA}`,
  `cat ./build/${COMMIT_SHA}`,
  "authorization: please review",
  "the /home/ directory and /Users/ folder",
  "short abc123 and 31 chars 0123456789abcdefghij0123456789a",
  "letters only abcdefghijklmnopqrstuvwxyzabcdefghij",
  "a basic understanding of Basic Authentication",
  "Basic JavaScript knowledge and BASIC programming",
  "see https://api.example.com/users/42/orders and /srv/home/app",
] as const;

describe("conversation redaction rules", () => {
  it.each(RULES)("masks $name", (rule) => {
    const result = redactConversationText(rule.input);

    expect(result.text).toBe(rule.output);
    expect(result.redactions).toEqual(rule.redactions);
    // Masked text never trips the pre-transmission check again.
    expect(findSensitiveContent(result.text)).toEqual([]);
  });

  it.each(UNCHANGED)("leaves %s unchanged", (text) => {
    expect(redactConversationText(text)).toEqual({ redactions: [], text });
  });

  it("masks a private key block that already holds a placeholder", () => {
    const result = redactConversationText(
      "-----BEGIN PRIVATE KEY-----\n[REDACTED]\nQUJDREVGRw==\n-----END PRIVATE KEY-----\nafter",
    );
    expect(result.text).toBe("[REDACTED]\nafter");
  });

  it("masks every shared detector kind", () => {
    const covered = new Set(
      RULES.flatMap((rule) => rule.redactions.map((entry) => entry.kind)),
    );

    for (const kind of SensitiveContentKindSchema.options) {
      expect(covered).toContain(kind);
    }
    expect(CONVERSATION_MASKING_RULES_VERSION).toMatch(
      /^conversation-mask-v1\.[0-9a-f]{12}$/u,
    );
  });

  it("is idempotent and never re-masks a placeholder", () => {
    for (const { input } of RULES) {
      const once = redactConversationText(input, { redactTerms: ["act"] });
      const twice = redactConversationText(once.text, { redactTerms: ["act"] });
      expect(twice.text).toBe(once.text);
    }
  });

  it("keeps the Authorization header from re-tripping transmission checks", () => {
    const masked = redactConversationText(
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
    ).text;

    expect(masked).toBe("Authorization: [REDACTED]");
    expect(() =>
      assertNoSensitiveContent(
        { text: masked },
        "conversation_provider_payload",
      ),
    ).not.toThrow();
    // The same unmasked header is still caught at the boundary.
    expect(() =>
      assertNoSensitiveContent(
        { text: "Authorization: Bearer abcdefghijklmnop" },
        "conversation_host_assisted_payload",
      ),
    ).toThrow(/SENSITIVE_CONTENT_DETECTED/u);
  });

  it("does not change PR-path detection", () => {
    // Conversation-only rules (SHA-like runs, JWT, home paths) stay out of
    // the shared detector, so review bodies with commit SHAs still pass.
    expect(
      findSensitiveContent({
        body: `Fixed in ${COMMIT_SHA}; JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln; see /Users/alice/repo`,
      }),
    ).toEqual([]);
    expect(findSensitiveContent({ body: "Authorization: Bearer x" })).toEqual([
      { kind: "authorization_header", path: "$.body" },
    ]);
  });

  it("adds both conversation boundaries", () => {
    expect(SensitiveContentBoundarySchema.options).toEqual(
      expect.arrayContaining([
        "conversation_host_assisted_payload",
        "conversation_provider_payload",
        "host_assisted_payload",
        "provider_distillation_payload",
      ]),
    );
  });
});

describe("user dictionary (redactTerms)", () => {
  it("matches regardless of case and full- or half-width forms", () => {
    const result = redactConversationText(
      "Ｔａｎａｋａ さん, TANAKA, tanaka-san, ﾀﾅｶ, タナカ",
      { redactTerms: ["Tanaka", "タナカ"] },
    );

    expect(result.text).toBe(
      "[REDACTED] さん, [REDACTED], [REDACTED]-san, [REDACTED], [REDACTED]",
    );
    expect(result.redactions).toEqual([{ count: 5, kind: "redact_term" }]);
  });

  it("applies full case folding to terms and text alike", () => {
    expect(
      redactConversationText("STRASSE, strasse, Straße", {
        redactTerms: ["Straße"],
      }).text,
    ).toBe("[REDACTED], [REDACTED], [REDACTED]");
    expect(
      redactConversationText("Straße", { redactTerms: ["STRASSE"] }).text,
    ).toBe("[REDACTED]");
    // Capital sharp s folds through ß to ss, like the other spellings.
    expect(
      redactConversationText("STRAẞE", { redactTerms: ["Straße"] }).text,
    ).toBe("[REDACTED]");
  });

  it("uses the current terms when the caller's list changes", () => {
    const terms = ["Alice"];
    expect(
      redactConversationText("Alice Bob", { redactTerms: terms }).text,
    ).toBe("[REDACTED] Bob");
    terms.push("Bob");
    expect(
      redactConversationText("Alice Bob", { redactTerms: terms }).text,
    ).toBe("[REDACTED] [REDACTED]");
  });

  it("maps a folded match back to whole original characters", () => {
    // "e" + COMBINING ACUTE folds to "é"; the mark must not survive.
    const result = redactConversationText("René and René", {
      redactTerms: ["rené"],
    });

    expect(result.text).toBe("[REDACTED] and [REDACTED]");
  });

  it("merges overlapping terms into one placeholder", () => {
    const result = redactConversationText("Acme Corporation", {
      redactTerms: ["acme corp", "corporation"],
    });

    expect(result.text).toBe("[REDACTED]");
    expect(result.redactions).toEqual([{ count: 1, kind: "redact_term" }]);
  });

  it.each([
    [
      "half-width kana with sound marks",
      "ガイア",
      "社名はｶﾞｲｱです",
      "社名は[REDACTED]です",
    ],
    [
      "decomposed Hangul",
      "한국",
      "\u1112\u1161\u11ab\u1100\u116e\u11a8 사람",
      "[REDACTED] 사람",
    ],
    [
      "Greek final sigma",
      "ΟΔΥΣΣΕΥΣ",
      "ΟΔΥΣΣΕΥΣ και οδυσσευς",
      "[REDACTED] και [REDACTED]",
    ],
  ])("matches %s", (_name, term, text, output) => {
    expect(redactConversationText(text, { redactTerms: [term] }).text).toBe(
      output,
    );
  });

  it("masks a long paste with many term matches in linear time", () => {
    const text = "the quick brown fox ".repeat(10_000);
    const started = performance.now();

    const result = redactConversationText(text, { redactTerms: ["fox"] });

    expect(result.redactions).toEqual([{ count: 10_000, kind: "redact_term" }]);
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it("never cuts through a placeholder", () => {
    const masked = "ab[REDACTED]cd";
    expect(truncateMaskedText(masked, 8)).toBe("ab");
    expect(truncateMaskedText(masked, 12)).toBe("ab[REDACTED]");
    expect(truncateMaskedText(masked, 13)).toBe("ab[REDACTED]c");
    expect(truncateMaskedText("a😀", 2)).toBe("a");
  });

  it.each([
    ["a long hyphenated run", "a-".repeat(40_000)],
    ["repeated empty connection strings", "x://:".repeat(20_000)],
    ["repeated secret keys", "password=".repeat(20_000)],
    ["a chain of home directories", "/home/a".repeat(20_000)],
    ["a long run of JWT starts", "eyJ-".repeat(100_000)],
    ["a chain of encoded home directories", "-Users-a".repeat(20_000)],
  ])("masks %s in linear time", (_name, text) => {
    const started = performance.now();

    redactConversationText(text, { redactTerms: ["ab"] });

    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("keeps git remotes around a masked address", () => {
    expect(
      redactConversationText("clone git@github.com:acme/api.git now").text,
    ).toBe("clone [REDACTED]:acme/api.git now");
  });

  it.each([
    ["a provider key", "acmesk-abcdefghijklmnop", "[REDACTED][REDACTED]"],
    ["a JWT", "acmeeyJhbGci.eyJzdWIi.sig rest", "[REDACTED][REDACTED] rest"],
  ])(
    "masks %s that a dictionary term right before it exposes",
    (_name, input, output) => {
      expect(
        redactConversationText(input, { redactTerms: ["acme"] }).text,
      ).toBe(output);
    },
  );

  it("masks a POSIX home path that a dictionary term would expose", () => {
    const result = redactConversationText("x/home/bob/repo", {
      redactTerms: ["x"],
    });

    expect(result.text).toBe("[REDACTED]~/repo");
  });

  it("masks a home path that a dictionary term would otherwise expose", () => {
    const result = redactConversationText("aC:\\Users\\bob\\x", {
      redactTerms: ["a"],
    });

    expect(result.text).toBe("[REDACTED]~\\x");
  });

  it("keeps the longer of two terms that start at the same place", () => {
    const result = redactConversationText("Acme Corp, Acme", {
      redactTerms: ["acme", "acme corp"],
    });

    expect(result.text).toBe("[REDACTED], [REDACTED]");
    expect(result.redactions).toEqual([{ count: 2, kind: "redact_term" }]);
  });

  it("ignores blank terms and normalizes the list", () => {
    expect(normalizeRedactTerms(["  ", "Ｂｏｂ", "bob", " Alice "])).toEqual([
      "alice",
      "bob",
    ]);
    expect(redactConversationText("bob", { redactTerms: [" "] }).text).toBe(
      "bob",
    );
  });

  it("keeps terms out of masking_version and binds it to the key", () => {
    const version = computeConversationMaskingVersion(KEY, ["Tanaka", "Acme"]);

    expect(version).toMatch(
      new RegExp(
        `^${CONVERSATION_MASKING_RULES_VERSION.replace(".", "\\.")}\\+terms\\.[0-9a-f]{16}$`,
        "u",
      ),
    );
    expect(version.toLowerCase()).not.toContain("tanaka");
    expect(version.toLowerCase()).not.toContain("acme");
    // Same normalized list, same version; any change or another key differs.
    expect(
      computeConversationMaskingVersion(KEY, ["acme", "ＴＡＮＡＫＡ"]),
    ).toBe(version);
    expect(computeConversationMaskingVersion(KEY, ["Tanaka"])).not.toBe(
      version,
    );
    expect(
      computeConversationMaskingVersion(Buffer.alloc(32, 8), [
        "Tanaka",
        "Acme",
      ]),
    ).not.toBe(version);
  });
});
