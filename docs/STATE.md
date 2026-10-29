# Current State

Current phase: PHASE 1 — DATA PIPELINE
Current PR: PR-01 — Core Domain & Database
Status: PR READY — waiting for owner verification and merge (pull request opened, not merged)

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
- **PR-01 — Core Domain & Database** (PR READY: Code & Safety Review PASS ×2, Quality Review
  ACCEPT; awaiting owner review of the pull request).
  - D-007 Accepted: Kysely `0.29.6` + `pg` `8.23.1` (+ `@types/pg` `8.23.1`); D-009 Accepted
    (profile = subscription, one table). PostgreSQL 16.
  - `DATABASE_URL` required (zod: `postgres:`/`postgresql:` URL); fixed pool limits
    (max 5, connect 5 s, idle 10 s, `statement_timeout` 30 s); pool closed after each command.
  - `src/domain/`: `Source`, `Opportunity`/`OpportunityDraft`, `CompanyProfile` (+ input/patch)
    with zod schemas; missing = `null`; `estimatedValue` as decimal string; `DomainError`
    (`invalid_input`, `duplicate`, `unknown_reference`, `constraint_violation`,
    `invalid_stored_row`). URLs stored as canonical WHATWG `href` (no whitespace/control
    chars); lone UTF-16 surrogates rejected in all text fields.
  - Migration `0001_core_schema` (explicit SQL, static provider, Kysely Migrator with lock):
    `sources`, `opportunities`, `company_profiles` with all ARCHITECTURE §5 constraints
    (+ status text CHECK, NaN/±Infinity rejected, jsonb-object CHECKs, normalized e-mail).
  - Repositories: sources (upsert/get/list enabled), opportunities (atomic upsert by
    fingerprint → `inserted`/`updated`, keeps `id`/`first_seen_at`), profiles (CRUD).
    SQLSTATE 23505/23503/23514/23502/class 22 → `DomainError` without server message/values.
  - CLI: async `runCli` with injected deps; `health` checks the DB (JSON report, exit 1 with
    fixed reason + SQLSTATE/errno, never the URL/password); new `migrate` (idempotent);
    unexpected errors → fixed internal-error message, exit 1.
  - 199 tests (45 integration on real PostgreSQL via `TEST_DATABASE_URL`, per-file schema;
    skipped with a visible NOTICE when the variable is unset).

## In progress

Nothing — PR-01 pull request awaits owner verification.

## Blockers

None.

## Decisions made

See `docs/DECISIONS.md` (D-001 … D-013). D-007 and D-009 accepted in PR-01.

## Next action

1. Owner reviews and merges the PR-01 pull request.
2. PR-02 — First Source Adapter (`docs/PR_PLAN.md`): step 0 = source selection recorded in
   DECISIONS (terms, robots.txt, API/feed availability, licence, small-order coverage).

Non-blocking follow-ups (handle when touching the files, no separate PR):

- From PR-01 Quality Review:
  - `health` reports `ok` on a reachable but un-migrated DB — consider reporting pending
    migrations (PR-07 ops or next time `health` is touched).
  - A failed `migrate` writes only to stderr; consider a JSON error report on stdout like
    `health`, and document `migrate` failure output in README.
  - README "Szybki start": add a one-line pointer to "Baza danych" (create role/DB) before
    `pnpm dev migrate`.
  - `Invalid environment configuration: DATABASE_URL` could say what is expected
    ("required, postgres:// or postgresql:// URL") without echoing the value.
  - **Product rule for PR-03/PR-04:** PRODUCT.md requires ≥ 1 profile category from a closed
    MVP list; the PR-01 schema accepts an empty list / free-form labels (consistent with
    ARCHITECTURE §5). Enforce the vocabulary when the category dictionary and the operator
    profile command are added.
- From the owner's PR-01 GitHub review (rules for later PRs):
  - **PR-03 normalizer:** a published contact e-mail that fails `emailSchema` (IDN domain,
    trailing dot) goes to `contact.raw` as published — it must not reject the whole notice.
  - **PR-03:** compute the fingerprint and `content_hash` from the validated draft (canonical
    `sourceUrl`), not from raw adapter input.
  - **PR-02:** `base_url` is a stored display link (IP literals / port 0 are accepted by the
    domain schema); never trust it as a fetch target without SafeHttpClient's host/SSRF checks.
  - **PR-04/05:** list/digest reads must handle `invalid_stored_row` per row (skip + log the
    row id), so one inconsistent row does not abort the whole run.
  - **PR-05/06:** stored URLs may still contain `'`, `` ` ``, `{`, `}` and percent-encoded
    controls — escape contextually on output (SECURITY §10).
  - **PR-07 CI:** set `CI`/`REQUIRE_DB_TESTS` with `TEST_DATABASE_URL`; without the URL the run
    now fails instead of skipping.
- From PR-01 Code & Safety Review (optional Low):
  - If `close()` fails after a successful command, stdout shows `ok` but exit is 1 (safe
    direction); assert/document it.
  - The internal-error catch-all gives no diagnostic hint; optionally add the error `name`
    or a SAFE_CODE-checked code (never message/stack).
- From PR-00 reviews:
  - `pnpm start/health/dev` print Node's ".env not found" notice on stderr when no `.env`
    exists (documented in README); production/cron should call `node dist/main.js` directly.
  - CLI usage says `radar-zamowien <command>` but there is no `bin` entry (revisit in PR-07).
  - No-argument usage goes to stdout (exit 2) while unknown-command usage goes to stderr.

## Last verification

2026-10-29, PR-01 session (Node 22.22.0, pnpm 10.28.0, PostgreSQL 16.15):

- `TEST_DATABASE_URL=… pnpm check` — format, lint, typecheck clean; 199/199 tests passed
  (11 files, 45 integration, 0 skipped). Without `TEST_DATABASE_URL`: 155 passed, 44 skipped
  with the NOTICE line; with `CI`/`REQUIRE_DB_TESTS` set and no URL the run fails. `pnpm audit` — no known vulnerabilities.
- `pnpm build && node dist/main.js migrate` on an empty DB → `applied:["0001_core_schema"]`,
  rerun → `applied:[]`, 3 parallel runs → applied once; `health` → `status ok`, exit 0.
  Unreachable/wrong-password/missing-DB/unknown-host/timeout → exit 1, password never printed.
- Code & Safety Review: round 1 PASS (1 Medium, 5 Low + 1 optional → all fixed by Coder);
  round 2 PASS (0 Critical/High/Medium, 2 optional Low listed above). Quality Review: ACCEPT
  (non-blocking notes above).
- Owner GitHub review of 231417d: PASS with notes (1 Medium URL canonicalization, Lows:
  lone surrogates, raw ZodError on read, CI gate; Info: statement_timeout vs migrator lock).
  Fixed by Coder; Code & Safety Review round 3 PASS (0 findings).
- Working-tree fingerprint unchanged across every reviewer run.
