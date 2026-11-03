import { configDefaults, defineConfig } from "vitest/config";

/**
 * The backup/restore suite drops and recreates its schema's tables; Kysely's
 * Migrator in the other suites lists tables across every visible schema, and
 * a relation dropped under that catalog read fails it. So that suite runs
 * alone, after every other file (its own project, a later group).
 */
const EXCLUSIVE = ["tests/integration/backup-restore.test.ts"];

export default defineConfig({
  test: {
    environment: "node",
    restoreMocks: true,
    // Drops the PostgreSQL schemas created by integration tests after the run.
    globalSetup: ["tests/integration/global-setup.ts"],
    projects: [
      {
        extends: true,
        test: {
          name: "main",
          include: ["tests/**/*.test.ts"],
          exclude: [...configDefaults.exclude, ...EXCLUSIVE],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "exclusive",
          include: EXCLUSIVE,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
