import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  addCustomIssue,
  addDuplicateIdIssues,
  type CustomIssue,
} from "../src/zod-issues.js";

// `addCustomIssue` replaces `.superRefine()`'s `ctx.addIssue`. These cases pin
// that the two produce the same issues, so the migration did not change what
// callers see.

const Shape = z.strictObject({
  items: z.array(z.string()),
  name: z.string(),
});
type ShapeValue = z.output<typeof Shape>;

function rules(value: ShapeValue, report: (issue: CustomIssue) => void): void {
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

  it("keeps running the parent's checks after a child issue", () => {
    const parentCheck = (
      report: (issue: CustomIssue) => void,
      value: { children: unknown[] },
    ) => {
      if (value.children.length > 1) report({ message: "too many children" });
    };
    const WithCheckParent = z
      .strictObject({ children: z.array(WithCheck) })
      .check((context) => {
        parentCheck((issue) => addCustomIssue(context, issue), context.value);
      });
    const WithSuperRefineParent = z
      .strictObject({ children: z.array(WithSuperRefine) })
      .superRefine((value, context) => {
        parentCheck(
          (issue) => context.addIssue({ code: "custom", ...issue }),
          value,
        );
      });
    const input = {
      children: [
        { items: [], name: "" },
        { items: [], name: "ok" },
      ],
    };
    expect(issuesOf(WithCheckParent, input)).toEqual([
      {
        code: "custom",
        message: "name is empty",
        path: ["children", 0],
      },
      { code: "custom", message: "too many children", path: [] },
    ]);
    expect(issuesOf(WithCheckParent, input)).toEqual(
      issuesOf(WithSuperRefineParent, input),
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

describe("addDuplicateIdIssues", () => {
  const Rows = z.strictObject({
    rows: z.array(z.strictObject({ id: z.string() })),
  });
  const WithField = Rows.check((context) => {
    addDuplicateIdIssues(
      context,
      "rows",
      context.value.rows.map((row) => row.id),
    );
  });
  const WithLabel = Rows.check((context) => {
    addDuplicateIdIssues(
      context,
      "rows",
      context.value.rows.map((row) => row.id),
      "row",
    );
  });
  const input = { rows: [{ id: "a" }, { id: "b" }, { id: "a" }, { id: "a" }] };

  it("points at each repeated entry's id in the input", () => {
    const issues = issuesOf(WithField, input);
    expect(issues).toEqual([
      {
        code: "custom",
        message: "duplicate rows id a",
        path: ["rows", 2, "id"],
      },
      {
        code: "custom",
        message: "duplicate rows id a",
        path: ["rows", 3, "id"],
      },
    ]);
    for (const issue of issues) {
      const [, index] = issue.path;
      expect(input.rows[index as number]?.id).toBe("a");
    }
  });

  it("uses the label in the message when one is given", () => {
    expect(issuesOf(WithLabel, input).map((issue) => issue.message)).toEqual([
      "duplicate row id a",
      "duplicate row id a",
    ]);
  });

  it("accepts unique ids", () => {
    expect(issuesOf(WithField, { rows: [{ id: "a" }, { id: "b" }] })).toEqual(
      [],
    );
  });
});
