import { describe, expect, it } from "vitest";
import { applyDiscount } from "../src/discount.js";

describe("applyDiscount", () => {
  it("applies a percentage discount", () => {
    expect(applyDiscount(100, 25)).toBe(75);
  });
});
