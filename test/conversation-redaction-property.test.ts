import { describe, expect, it } from "vitest";

import { redactConversationText } from "../src/conversation-redaction.js";
import { findSensitiveContent } from "../src/sensitive-content.js";

/**
 * Seeded fuzz over the fragments that broke masking in review: detector
 * samples, header and scheme words, separators, quotes, newlines, literal
 * placeholders, home paths and short dictionary terms. Deterministic, so a
 * failure reproduces from its seed.
 */
const FRAGMENTS = [
  "Authorization",
  "authorization: ",
  '"Authorization": "',
  "Bearer ",
  "Basic ",
  "bearer",
  "token=",
  "DB_PASSWORD=",
  "pwd: ",
  " -u admin:",
  "mysql -p",
  "hf_",
  "password: ",
  "sk-ant-abcdefghijklmnop",
  "ghp_0123456789abcdefghij0123456789",
  "xoxb-1234567890-abcdef",
  "AKIAIOSFODNN7EXAMPLE",
  "AIzaSyA0123456789abcdefghijklmnopqrstuv",
  "-----BEGIN PRIVATE KEY-----",
  "-----END PRIVATE KEY-----",
  "-----BEGIN PGP PRIVATE KEY BLOCK-----",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln",
  "alice@example.com",
  "postgres://admin:p@ss@db.example.test/x",
  "/Users/alice/",
  "/home/bob",
  "-Users-alice-",
  "-home-bob-",
  "C:\\Users\\Carol Ann\\",
  "~/",
  "[REDACTED]",
  "[REDAC",
  "3f2a9c1e0b7d4a6f8e2c5b1a9d3f7e6c4b2a1d0e",
  "dXNlcjpwYXNzd29yZA==",
  "abc123",
  "@",
  "/",
  "\\",
  ":",
  "=",
  '"',
  "'",
  "`",
  " ",
  "\n",
  ",",
  ".",
  "ed",
  "Tanaka",
  "ﾀﾅｶ",
  "café",
  "田中",
  "たなか",
  "タナカ",
  "が",
  "か\u3099",
  "\u3000",
  "「",
  "」",
] as const;
const TERMS = [
  "ed",
  "tanaka",
  "a",
  "田中",
  "たなか",
  "タナカ",
  "がい",
] as const;

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

describe("conversation masking invariants", () => {
  it("never leaves a detector match and is a fixpoint", () => {
    for (let seed = 1; seed <= 3_000; seed += 1) {
      const next = random(seed);
      const length = 1 + Math.floor(next() * 12);
      const text = Array.from(
        { length },
        () => FRAGMENTS[Math.floor(next() * FRAGMENTS.length)]!,
      ).join("");
      const redactTerms = next() < 0.5 ? [] : [...TERMS];

      const masked = redactConversationText(text, { redactTerms }).text;

      expect({ seed, findings: findSensitiveContent(masked) }).toEqual({
        findings: [],
        seed,
      });
      expect({
        again: redactConversationText(masked, { redactTerms }).text,
        seed,
      }).toEqual({ again: masked, seed });
      // No term survives in any span between placeholders, however folded.
      for (const span of masked.split("[REDACTED]")) {
        const folded = span.normalize("NFKC").toLowerCase();
        for (const term of redactTerms) {
          expect({ seed, term, survives: folded.includes(term) }).toEqual({
            seed,
            survives: false,
            term,
          });
        }
      }
    }
  });
});
