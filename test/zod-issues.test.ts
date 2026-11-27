import { describe, expect, it } from "vitest";
import { z } from "zod";

import { addCustomIssue } from "../src/zod-issues.js";

// `addCustomIssue` replaces `.superRefine()`'s `ctx.addIssue`. These cases pin
// that the two produce the same issues, so the migration did not change what
// callers see.

const Shape = z.strictObject({
  items: z.array(z.string()),
  name: z.string(),
});
type ShapeValue = z.output<typeof Shape>;

function rules(
  value: ShapeValue,
  report: (issue: { message: string; path?: PropertyKey[] }) => void,
): void {
  if (value.name.length === 0) report({ message: "name is empty" });
  for (const [index, item] of value.items.entries()) {
    if (item === "bad") {
      report({ message: `bad item ${index}`, path: ["items", index] });
    }
  }
}

const WithCheck = Shape.check((context) => {
  rules(context.value, (issue) => addCustomIssue(context, issue));
});

const WithSuperRefine = Shape.superRefine((value, context) => {
  rules(value, (issue) => context.addIssue({ code: "custom", ...issue }));
});

function issuesOf(schema: z.ZodType, input: unknown) {
  const result = schema.safeParse(input);
  return result.success ? [] : result.error.issues;
}

describe("addCustomIssue", () => {
  it.each([
    { input: { items: [], name: "ok" }, label: "valid input" },
    { input: { items: [], name: "" }, label: "an issue without a path" },
    {
      input: { items: ["ok", "bad", "bad"], name: "" },
      label: "several issues with paths",
    },
  ])("reports the same issues as superRefine for $label", ({ input }) => {
    expect(issuesOf(WithCheck, input)).toEqual(
      issuesOf(WithSuperRefine, input),
    );
  });

  it("builds a custom issue with the message and path", () => {
    expect(issuesOf(WithCheck, { items: ["bad"], name: "" })).toEqual([
      { code: "custom", message: "name is empty", path: [] },
      { code: "custom", message: "bad item 0", path: ["items", 0] },
    ]);
  });

  it("prefixes the path when the schema is nested", () => {
    const Parent = z.strictObject({ child: WithCheck });
    const input = { child: { items: ["bad"], name: "ok" } };
    expect(issuesOf(Parent, input)).toEqual([
      { code: "custom", message: "bad item 0", path: ["child", "items", 0] },
    ]);
    expect(issuesOf(Parent, input)).toEqual(
      issuesOf(z.strictObject({ child: WithSuperRefine }), input),
    );
  });

  it("keeps running later checks, like superRefine", () => {
    const Chained = WithCheck.check((context) => {
      addCustomIssue(context, { message: "later check ran" });
    });
    expect(
      issuesOf(Chained, { items: [], name: "" }).map((issue) => issue.message),
    ).toEqual(["name is empty", "later check ran"]);
  });

  it("stops a following transform, like superRefine", () => {
    let transformed = 0;
    const count = (value: ShapeValue) => {
      transformed += 1;
      return value;
    };
    const input = { items: [], name: "" };
    expect(WithCheck.transform(count).safeParse(input).success).toBe(false);
    expect(WithSuperRefine.transform(count).safeParse(input).success).toBe(
      false,
    );
    expect(transformed).toBe(0);
  });
});
