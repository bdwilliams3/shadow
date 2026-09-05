import { test } from "node:test";
import assert from "node:assert/strict";
import { isAvailable } from "../client/health.ts";

test("recognizes an available service", () => {
  assert.equal(isAvailable("healthy"), true);
});
