import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

type Module = typeof import("../src/zod-compile-when-hot.js");

// The module keeps process-wide state, so each case loads a fresh copy.
async function freshModule(): Promise<Module> {
  vi.resetModules();
  return import("../src/zod-compile-when-hot.js");
}

const Schema = () => z.strictObject({ id: z.string().min(1) });

describe("compileWhenHot", () => {
  it("leaves schemas alone until it is enabled", async () => {
    const { compileWhenHot } = await freshModule();
    const schema = Schema();
    const { parse } = schema;
    expect(compileWhenHot(schema)).toBe(schema);
    expect(schema.parse).toBe(parse);
  });

  it("switches to the compiled copy after the threshold", async () => {
    const { compileWhenHot, enableCompileWhenHot } = await freshModule();
    const schema = compileWhenHot(Schema());
    const { parse, safeParse, validate } = schema;
    const compiled = z.compile(schema);
    const compile = vi.fn(() => compiled);
    enableCompileWhenHot({ afterUses: 2, compile });

    // afterUses uses stay on the runtime parser; the next one compiles.
    schema.parse({ id: "a" });
    schema.safeParse({ id: "b" });
    expect(compile).not.toHaveBeenCalled();
    expect(schema.validate({ id: "c" })).toBe(true);
    expect(compile).toHaveBeenCalledTimes(1);
    schema.parse({ id: "d" });
    expect(compile).toHaveBeenCalledTimes(1);
    // The second argument is the schema's own parsers, not the counting ones.
    expect(compile).toHaveBeenCalledWith(
      schema,
      expect.objectContaining({ parse, safeParse, validate }),
    );
  });

  it("installs schemas marked after it was enabled, once each", async () => {
    const { compileWhenHot, enableCompileWhenHot } = await freshModule();
    const compile = vi.fn((schema: z.ZodType) => z.compile(schema));
    enableCompileWhenHot({ afterUses: 0, compile });
    const schema = compileWhenHot(compileWhenHot(Schema()));

    schema.parse({ id: "a" });
    schema.parse({ id: "b" });
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it("compiles once even for a parse method read before the switch", async () => {
    const { compileWhenHot, enableCompileWhenHot } = await freshModule();
    const compile = vi.fn((schema: z.ZodType) => z.compile(schema));
    enableCompileWhenHot({ afterUses: 0, compile });
    const schema = compileWhenHot(Schema());
    const { safeParse } = schema;

    safeParse({ id: "a" });
    safeParse({ id: "b" });
    expect(compile).toHaveBeenCalledTimes(1);
    expect(safeParse({ id: "" }).success).toBe(false);
  });

  it("counts ~standard.validate, which the MCP SDK calls, with the methods", async () => {
    const { compileWhenHot, enableCompileWhenHot } = await freshModule();
    const schema = compileWhenHot(Schema());
    const compile = vi.fn((source: z.ZodType) => z.compile(source));
    enableCompileWhenHot({ afterUses: 2, compile });

    schema.parse({ id: "a" });
    schema["~standard"].validate({ id: "b" });
    expect(compile).not.toHaveBeenCalled();
    expect(schema["~standard"].validate({ id: "c" })).toStrictEqual({
      value: { id: "c" },
    });
    expect(compile).toHaveBeenCalledTimes(1);
    expect(schema["~standard"].validate({ id: "" })).toStrictEqual(
      Schema()["~standard"].validate({ id: "" }),
    );
  });

  it("keeps the JSON Schema, and the vendor, version and jsonSchema of ~standard", async () => {
    const { compileWhenHot, enableCompileWhenHot } = await freshModule();
    const schema = compileWhenHot(Schema().meta({ description: "kept" }));
    const before = z.toJSONSchema(schema);
    const { jsonSchema, vendor, version } = schema["~standard"];
    const listed = jsonSchema.input({ target: "draft-2020-12" });
    enableCompileWhenHot({ afterUses: 0 });
    schema.parse({ id: "a" });
    schema["~standard"].validate({ id: "a" });

    expect(z.toJSONSchema(schema)).toStrictEqual(before);
    expect(schema["~standard"].vendor).toBe(vendor);
    expect(schema["~standard"].version).toBe(version);
    expect(schema["~standard"].jsonSchema).toBe(jsonSchema);
    expect(
      schema["~standard"].jsonSchema.input({ target: "draft-2020-12" }),
    ).toStrictEqual(listed);
  });

  it("parses, rejects and validates like the runtime parser", async () => {
    const { compileWhenHot, enableCompileWhenHot } = await freshModule();
    const runtime = Schema();
    const schema = compileWhenHot(Schema());
    enableCompileWhenHot({ afterUses: 0 });

    for (const input of [{ id: "a" }, { id: "" }, { id: "a", extra: 1 }, 1]) {
      expect(schema.safeParse(input)).toStrictEqual(runtime.safeParse(input));
      expect(schema.validate(input)).toBe(runtime.validate(input));
    }
    expect(schema.parse({ id: "a" })).toStrictEqual({ id: "a" });
    expect(() => schema.parse({ id: "" })).toThrow(z.ZodError);
  });
});
