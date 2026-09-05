import { describe, expect, it } from "vitest";
import { isAvailable } from "../client/health.js";

describe("health contract", () => {
  it("recognizes an available service", () => {
    expect(isAvailable("ok")).toBe(true);
  });
});
