import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
    // Drops the PostgreSQL schemas created by integration tests after the run.
    globalSetup: ["tests/integration/global-setup.ts"],
  },
});
