import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Integration tests spawn git, npm, node, and python3. Under host load those
    // routinely exceed the 5 s default and produced false failures unrelated to code.
    testTimeout: 30_000
  }
});
