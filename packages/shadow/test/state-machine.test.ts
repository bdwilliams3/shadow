import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, stateForStage } from "../src/orchestration/state-machine.js";

describe("state machine", () => {
  it("maps lifecycle stages to run states", () => {
    expect(stateForStage("test")).toBe("TESTING");
    expect(stateForStage("deploy")).toBe("DEPLOYING");
  });

  it("accepts valid transitions", () => {
    expect(canTransition("RECEIVED", "CLASSIFIED")).toBe(true);
    expect(() => assertTransition("RECEIVED", "CLASSIFIED")).not.toThrow();
    expect(canTransition("AWAITING_APPROVAL", "TESTING")).toBe(true);
  });

  it("rejects invalid transitions", () => {
    expect(canTransition("COMPLETED", "EXECUTING")).toBe(false);
    expect(() => assertTransition("COMPLETED", "EXECUTING")).toThrow(/Invalid run transition/);
  });
});
