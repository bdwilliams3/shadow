import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/defaults.js";
import { evaluatePolicy } from "../src/policies/policy.js";

describe("evaluatePolicy", () => {
  it("allows read-only actions without approval", () => {
    const decision = evaluatePolicy(
      {
        id: "repo.inspect",
        description: "Inspect repository",
        risk: "read_only",
        writesWorkspace: false,
        writesOutsideWorkspace: false,
        usesNetwork: false,
        deploys: false,
        touchesSecrets: false
      },
      defaultConfig
    );

    expect(decision).toEqual({ allowed: true, requiresApproval: false, reasons: [] });
  });

  it("requires approval for destructive actions", () => {
    const decision = evaluatePolicy(
      {
        id: "files.delete",
        description: "Delete files",
        risk: "destructive",
        writesWorkspace: true,
        writesOutsideWorkspace: false,
        usesNetwork: false,
        deploys: false,
        touchesSecrets: false
      },
      defaultConfig
    );

    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(true);
  });
});
