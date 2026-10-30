# Current State

Current phase: PHASE 1 — DATA PIPELINE
Current PR: PR-02 — First Source Adapter
Status: IN PROGRESS — Part A (SafeHttpClient) ready for owner verification (pull request opened,
not merged); Part B (source selection + adapter) BLOCKED — see Blockers

## Completed

- **PR-00 — Project Bootstrap** (PR READY: Code & Safety Review PASS, Quality Review ACCEPT).
  - Toolchain: pnpm 10.28 (D-002), Node ≥ 22.13 (raised to ≥ 22.19 in PR-02), TypeScript 6.0 strict, ESLint 10
    (strictTypeChecked), Prettier 3.9, Vitest 5.
  - CLI `health` (exit codes 0/1/2), config validation with zod, JSON-lines logger
    (no production callers yet — first caller expected in PR-02/03), `.env` loading via
    `node --env-file-if-exists=.env` in pnpm scripts.
  - 31 tests: unit (config, logger, CLI) + smoke tests on the real entry point.
  - Documentation: `CLAUDE.md`, `README.md`, `docs/*`.
  - Agent definitions: `coder`, `code-and-safety-reviewer`, `quality-reviewer`.
- **PR-01 — Core Domain & Database** (MERGED a94f2b9: Code & Safety Review PASS ×3, Quality
  Review ACCEPT, owner review addressed).
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

**PR-02 — First Source Adapter**, split into two increments on the same PR line:

- **Part A — SafeHttpClient (done, Code & Safety Review PASS ×3, Quality Review ACCEPT).**
  `src/infrastructure/http/` — the only network route for adapters (D-014, no new dependency):
  - `node:https` with a pinned `lookup` (DNS resolved once, every address checked, connection to
    the validated IP, SNI/Host = hostname); `HTTPS_PROXY` deliberately ignored.
  - URL policy: https only, default port, no credentials, no IP literals, exact host allowlist.
    Address policy: private/loopback/link-local/CGNAT/multicast/reserved IPv4 blocked;
    IPv6 allow-only `2000::/3` minus special ranges; IPv4-mapped always blocked.
  - Manual redirects (max 3, every hop revalidated); timeouts connect 10 s / total 30 s per
    attempt + optional caller `signal`; 5 MB limit (streamed, also after gzip/deflate/br
    decompression; an empty body is returned as-is whatever its Content-Encoding); per-host
    min interval 2 s (floor 1 s, sequential queue, monotonic clock; the caller `signal` also
    cancels the wait in the queue without letting later calls overtake the in-flight request);
    retries max 2 only for timeouts/transient errnos/429/502/503/504 with jittered backoff and
    `Retry-After` (cap 60 s, per-host deadline); error budget 10 attempts.
  - User-Agent `RadarZamowien/0.1 (+<CRAWLER_CONTACT>)`; `CRAWLER_CONTACT` optional in config,
    required to construct the client (README "Konfiguracja", `.env.example`).
  - Test-only deps (resolver/transport/clock/limits) guarded by an ESLint rule in `src/**`.
  - `engines` raised to Node ≥ 22.19 (tests use `tls.setDefaultCACertificates`); `openssl` CLI
    needed for the real-TLS transport tests.
  - AC3 met: timeout, size exceeded, host outside allowlist, private address, redirect outside
    allowlist, retry only for transient errors — 241 new tests (440 total).
  - Owner GitHub review of 11d8c4f: PASS (2 Low + Info + Nit), all addressed in a follow-up.
- **Part B — not started:** step 0 source selection recorded in DECISIONS (terms, robots.txt,
  API/feed, licence, small-order coverage) → adapter fetch → extract → normalize, real fixtures,
  parser tests, `source:preview <id>`, per-run logs (AC1, AC2, AC4).

## Blockers

- **Part B / step 0:** the session container's network policy denies the candidate source hosts
  (`ezamowienia.gov.pl`, `media.ezamowienia.gov.pl`,
  `bazakonkurencyjnosci.funduszeeuropejskie.gov.pl`, `bazakonkurencyjnosci.gov.pl`). The owner
  must allow them (environment settings → Network access) for source research and capturing real
  fixtures. No mocked or invented source data is used meanwhile.
- **AC1 cannot be verified in the session container even after allowing the hosts:** the
  container has proxy-only egress (no direct DNS/TCP) and SafeHttpClient ignores the proxy by
  design (D-014). Owner decision needed: will the production cron host have direct outbound
  HTTPS?
  - (A, recommended) keep D-014; use the container (curl via proxy) only for step 0 research and
    fixture capture; verify `source:preview` (AC1) on the owner's machine / production host and
    record "AC1 verified by owner outside the container".
  - (B) only if production is proxy-only too: add CONNECT-proxy support with a D-014 revision
    (local IP pinning loses meaning behind a proxy).

## Decisions made

See `docs/DECISIONS.md` (D-001 … D-014). D-007 and D-009 accepted in PR-01; D-014 (HTTP client
on `node:https` with pinned lookup, no HTTP library) accepted in PR-02 Part A.

## Next action

1. Owner verifies the PR-02 Part A pull request and answers the blocker questions above (allow
   the hosts; direct egress on the production host?).
2. PR-02 Part B, step 0: source selection recorded in DECISIONS, then the adapter.

PR-02 Part B to-dos (from Part A reviews):

- Bound each source run with a caller `AbortSignal` (run-level timeout, SECURITY §4); note the
  per-attempt worst case is 30 s × (1 + 2 retries) + backoff.
- Enforce page/record limits per run (SECURITY §5); check robots.txt and terms in step 0.
- The client supports GET only, fixed `Accept: */*`, https, default port, no proxy. If the source
  needs more (e.g. POST search, JSON Accept), extend it deliberately with a D-014 amendment.
- Review the adapter's construction of `SafeHttpClient` by hand: the lint guard does not catch
  aliasing (`const C = SafeHttpClient`), `Reflect.construct` or renamed re-exports (optionally add
  an `ExportSpecifier` selector).
- Optional simplification: advertise only `gzip` and drop the br/raw-deflate paths unless the
  chosen source uses them.
- URL-policy rejections (`invalid_url`, `host_not_allowed`) consume the error budget, so the
  adapter must pre-check every detail/attachment link with the pure
  `parseRequestUrl(link, normalizeAllowedHosts(allowedHosts))` from
  `src/infrastructure/http/address-policy.ts` (no traffic, no budget) before calling `get()`.
  Off-allowlist links (e.g. `platformazakupowa.pl`, `http://`, attachments on another host) are
  stored as `sourceUrl` without fetching, or dropped with a logged reason; otherwise ~10 foreign
  links exhaust the budget and stop the run.
- Decide whether a caller abort during a running attempt should consume the error budget: today a
  run timeout that cuts off an in-flight request counts as a failure, while the same abort in the
  queue or a rate-limit/backoff sleep does not (from the Part A owner-review re-review, Info).

Non-blocking follow-ups (handle when touching the files, no separate PR):

- From PR-02 Part A Quality Review:
  - `Invalid environment configuration: CRAWLER_CONTACT` does not state the expected format —
    fix together with the `DATABASE_URL` message follow-up below.
  - Decompression test titles print `[Function syncBufferWrapper]` instead of the encoding name
    (cosmetic, `tests/safe-http-client.test.ts`).
  - A missing `openssl` CLI makes the transport test fail in `beforeAll` (documented in README).

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

2026-10-30, PR-02 Part A owner-review follow-up (Node 22.22.0, pnpm 10.28.0, PostgreSQL 16):

- Owner GitHub review of 11d8c4f: PASS, 0 Critical/High/Medium; 2 Low (empty body with
  Content-Encoding → `decompression_failed`; caller `signal` ignored while queued), 1 Info
  (Part B link pre-check to-do), 1 Nit (D-014 `engines` rationale) and the PR_PLAN split record —
  all addressed.
- `TEST_DATABASE_URL=… REQUIRE_DB_TESTS=1 pnpm check` — format, lint, typecheck clean;
  440/440 tests passed (15 files). No dependency changes.

2026-10-29, PR-02 Part A session (Node 22.22.0, pnpm 10.28.0, PostgreSQL 16):

- `TEST_DATABASE_URL=… REQUIRE_DB_TESTS=1 pnpm check` — format, lint, typecheck clean;
  433/433 tests passed (15 files). `pnpm audit` — no known vulnerabilities.
- `health`/`migrate` unchanged with `CRAWLER_CONTACT` unset (exit 0); malformed value → exit 1
  without echoing it. Real client: `localhost` → `blocked_address`; external hosts →
  `dns_failed/ENOTFOUND` in the container (no direct egress — see Blockers).
- Code & Safety Review: round 1 (3 Medium), round 2 (1 Medium) — all fixed; round 3 PASS
  (0 Critical/High/Medium). Quality Review: ACCEPT for Part A (PR-02 not READY until Part B).
- Working-tree fingerprint unchanged across every reviewer run.

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
