import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDiscount } from "../src/discount.ts";

test("applies a percentage discount", () => {
  assert.equal(applyDiscount(100, 25), 75);
});
