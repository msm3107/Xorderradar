# Current State

Current phase: PHASE 1 — DATA PIPELINE
Current PR: PR-01 — Core Domain & Database
Status: READY TO START

## Completed

- **PR-00 — Project Bootstrap** (PR READY: Code & Safety Review PASS, Quality Review ACCEPT).
  - Toolchain: pnpm 10.28 (D-002), Node ≥ 22.13, TypeScript 6.0 strict, ESLint 10
    (strictTypeChecked), Prettier 3.9, Vitest 5.
  - CLI `health` (exit codes 0/1/2), config validation with zod, JSON-lines logger
    (no production callers yet — first caller expected in PR-02/03), `.env` loading via
    `node --env-file-if-exists=.env` in pnpm scripts.
  - 31 tests: unit (config, logger, CLI) + smoke tests on the real entry point.
  - Documentation: `CLAUDE.md`, `README.md`, `docs/*`.
  - Agent definitions: `coder`, `code-and-safety-reviewer`, `quality-reviewer`.

## In progress

Nothing.

## Blockers

None for PR-01. (Operational note: the GitHub remote had no branches before PR-00, so there
was no base branch to open a pull request against; PR-00 was pushed to the session branch.)

## Decisions made

See `docs/DECISIONS.md` (D-001 … D-013). Open for PR-01: **D-007 (ORM/migrations)**,
D-009 (profile = subscription, one table).

## Next action

PR-01 — Core Domain & Database (`docs/PR_PLAN.md`):

1. Decide D-007 (Drizzle ORM + drizzle-kit vs Kysely + migrator) against the criteria in
   DECISIONS; confirm PostgreSQL version (README says 16 — local 16.x is available).
2. Local PostgreSQL for tests (docker compose or documented setup).
3. Coder implements → Code & Safety Review → Quality Review (`docs/AGENTS.md`).

Non-blocking follow-ups from PR-00 reviews (handle when touching the files, no separate PR):

- DECISIONS D-012: reword "Reviewerzy bez narzędzi edycji" → "bez Edit/Write"; D-013: list
  `docs/STATE.md` as English. ARCHITECTURE §7: mark `sourceId` logging / `ingestion_runs`
  as plan.
- `pnpm start/health/dev` print Node's ".env not found" notice on stderr when no `.env`
  exists (documented in README); production/cron should call `node dist/main.js` directly.
- CLI usage says `radar-zamowien <command>` but there is no `bin` entry (revisit in PR-07).
- No-argument usage goes to stdout (exit 2) while unknown-command usage goes to stderr.

## Last verification

2026-10-29, PR-00 session (Node 22.22.0, pnpm 10.28.0):

- Clean copy: `pnpm install --frozen-lockfile` OK; `pnpm audit` — no known vulnerabilities.
- `pnpm check` — format, lint, typecheck clean; 31/31 tests passed.
- `pnpm health`, `pnpm build && node dist/main.js health` → `{"status":"ok",...}` exit 0;
  unknown command → 2; invalid config → 1 without echoing values.
- Code & Safety Review: round 1 PASS (2 Medium, 5 Low → fixed by Coder); round 2 PASS
  (0 Critical/High/Medium, 2 optional Low). Quality Review: ACCEPT (non-blocking notes above).
- Agents ran as separate subagents using the `.claude/agents/*.md` definitions (they load
  natively only from the next session). Working-tree fingerprint unchanged across every
  reviewer run.
