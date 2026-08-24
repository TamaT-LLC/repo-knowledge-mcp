import { expect, test } from "vitest";

import { classify } from "./source.js";

test("covers only one path", () => {
  expect(classify(true)).toBe("covered");
});
