# Current State

Current phase: PHASE 1 — DATA PIPELINE
Current PR: PR-02 — First Source Adapter
Status: IN PROGRESS — Part A (SafeHttpClient) MERGED (PR #2, 5533384); Part B (BZP adapter +
`source:preview`) implemented and reviewed (Code & Safety Review PASS ×2 rounds, Quality Review
PASS, round-2 fixes applied; owner GitHub review of PR #3 (bf74ad9): code PASS, follow-up fixes
applied); AC1 pending owner verification on a machine with direct egress — see Blockers

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

- **Part A — SafeHttpClient (MERGED as PR #2, 5533384; Code & Safety Review PASS ×3, Quality
  Review ACCEPT, owner review PASS).**
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
- **Part B — implemented; Code & Safety Review PASS (2 rounds), Quality Review PASS, fixes from
  both rounds applied.**
  - Step 0: D-015 — BZP through the official "API BZP (WebService)" of e-Zamówienia
    (`GET /mo-board/api/v1/notice`, terms §11, licence, coverage incl. small contracts; robots.txt
    and the terms are re-checked by the operator, not at runtime). Rejected: Baza
    Konkurencyjności, the internal Board/Search endpoint.
  - `src/sources/types.ts`: `SourceAdapter` contract, `FetchContext`, `FetchResult` (documents +
    `incomplete` limits), `NormalizeResult`, `SourceFormatError`. `src/domain/opportunity.ts`:
    new `OpportunityCandidate` (= draft without `fingerprint`/`contentHash`, computed in PR-03);
    the draft schema is unchanged in behaviour.
  - `src/sources/bzp/`: `ContractNotice` + `SmallContractNotice`, PageSize ≤ 25 with
    `SearchAfter` keyset pagination; stops on empty/short page, 40 pages and the record limit per
    notice type (so `ContractNotice` cannot starve `SmallContractNotice`; a run returns at most
    2 × limit records), invalid or repeated cursor, aborted signal. Pure `extract` (only mapped fields kept,
    `htmlBody` dropped) and `normalize` (strict UTC dates, CPV codes, buyer seat + static
    province map, description/contact/value `null`).
  - `src/sources/registry.ts`, `src/sources/preview.ts`; CLI
    `source:preview <sourceId> [--date YYYY-MM-DD] [--limit N]` (default yesterday UTC / 20
    records per notice type, max 500, run timeout 5 min, requires `CRAWLER_CONTACT`, never
    opens the DB, JSON report on stdout, logs with sourceId/status/durationMs/counts). HTTP
    client factory and adapters are injected via `CliDeps.sources`.
  - Real fixtures (`tests/fixtures/bzp/`, captured 2026-10-30, byte-identical except
    pseudonymised personal contact data in `htmlBody`, excluded from Prettier) + tests: exact
    mapping, every record normalizes, province map = official glossary, mutated-record edge
    cases, unusable documents, fetch loop with a fake client (exact URLs and every stop
    condition), CLI tests, one smoke test (AC2, AC4).
  - Part B to-dos from the Part A reviews resolved: run-level `AbortSignal` (CLI, 5 min);
    page/record limits; GET with `Accept: */*` is enough for the JSON API (no D-014 amendment);
    link pre-check not needed (no source links are fetched — detail URLs are stored only);
    abort-vs-error-budget left unchanged and recorded in D-015 (one client per run, an abort ends
    the run); `SafeHttpClient` is constructed once, in `defaultSourceDeps` in `src/cli.ts`, with
    options only (for manual review). Not done (optional): gzip-only simplification.

## Blockers

- **AC1 (real notices via `source:preview`) cannot be verified in the session container:**
  the owner already verified the adapter loop against the live API through the container proxy
  (2026-10-28: 15 requests, 338 records, 0 rejected, `incomplete` `[]`), but AC1 still needs the
  SafeHttpClient run itself, outside the container. The container has proxy-only egress and
  SafeHttpClient ignores the proxy by design (D-014). Owner runs, on a machine with direct
  outbound HTTPS, with a real, monitored contact of the operator and a past weekday:
  `CRAWLER_CONTACT=<twój-monitorowany-kontakt> DATABASE_URL=postgres://… pnpm dev source:preview bzp --date 2026-10-29 --limit 25 | jq .`
  and records "AC1 verified by owner outside the container" with the counts. PR-02 is not READY
  before that.

  **Expected result / what to check:**
  - Exit code 0 (`echo $?`). stdout is one line of JSON — pipe it to `jq .` or
    `python -m json.tool` to read it; the log lines go to stderr.
  - `normalized` > 0, and **both** notice types delivered data: the stderr log lines
    `source listing fetched` (one per `part`: `ContractNotice`, `SmallContractNotice`) each show
    `records` > 0.
  - `rejected` is 0, or every rejection has a reason that is explainable from the notice.
  - `incomplete`: `max_records` for a part means more notices may exist for that day — expected
    with a small `--limit`; it is not an error. Other reasons (`max_pages`, `invalid_cursor`,
    `repeated_cursor`) should be reported back.
  - Open 2–3 `sourceUrl` links in a browser and compare the title, buyer and submission deadline
    with the page. Deadlines are printed in UTC (e.g. `08:00Z` = 09:00 CET on the page), so a
    1–2 h difference is not a bug.

- Open owner question (affects PR-07, not Part B): will the production cron host have direct
  outbound HTTPS? If production is proxy-only too, CONNECT-proxy support needs a D-014 revision.

## Decisions made

See `docs/DECISIONS.md` (D-001 … D-015). D-007 and D-009 accepted in PR-01; D-014 (HTTP client
on `node:https` with pinned lookup, no HTTP library) accepted in PR-02 Part A; D-015 (first
source: BZP through the official API) in PR-02 Part B.

## Next action

1. Owner verifies AC1 outside the container (command and checklist under Blockers) and
   reviews the PR.
2. PR-03 — ingestion: fingerprint/`contentHash` from the validated candidate, storage,
   `ingestion_runs`. Open points from D-015 for PR-03: whether the API's publication-day
   boundary is UTC or Polish time (overlapping days + dedup make it harmless); scheduling of the
   run per day. The ingestion run budget must not starve either notice type (keep the
   per-notice-type limit of `source:preview`, or an equivalent). Size the ingestion limit and
   run timeout together (Code & Safety re-review, Low): with `maxRecords` > 1000 a run can reach
   80 pages (≥ 158 s of rate-limit gaps alone), so the 5-min timeout could abort a busy day
   all-or-nothing — use timeout ≥ pages × (2 s + latency), or keep pages fetched before the
   timeout and mark the run `incomplete`. Run extract → normalize per page (per document) and
   drop the document `body` right after extraction instead of keeping every page until the end
   of the run: `htmlBody` is ≈ 95% of the bytes (~70 MB per source at 1000 records per type),
   so streaming per document keeps D-008 (raw data only in memory) with constant memory per
   page.

Notes from Part B (for later PRs):

- `tests/fixtures/bzp/README.md`: the exact `NoticeType`/`PageSize` of the captured empty day are not
  recorded (written as `…`); the body `[]` is the real response.
- Optional simplification (Part A review): advertise only `gzip` and drop the br/raw-deflate paths
  of SafeHttpClient — not done, out of Part B scope.
- `source:preview` validates `DATABASE_URL` although it never opens the database (shared
  config schema, existing config tests); revisit if a DB-less deployment of preview is needed,
  and improve the resulting error message (it should say the variable is required by the shared
  configuration even for preview) together with the `DATABASE_URL` message follow-up below.
- Fixtures pseudonymised (owner decision, PR #3 review): in `htmlBody` every e-mail →
  `kontakt@example.invalid`, every phone/fax → `000 000 000`, natural-person names →
  `Jan Kowalski` (none present); string-level replacement, everything else byte-identical. The
  same rule applies to future fixtures, including the PR-03 HTML fixtures
  (`tests/fixtures/bzp/README.md`, ARCHITECTURE §2). The unredacted files remain in the history
  of the already pushed commit bf74ad9; the owner decided against a history rewrite (fix as a
  new commit; a squash merge keeps bf74ad9 out of the base branch, but it stays visible in
  PR #3's history on GitHub).
- Known coverage limitation (D-015): BZP has few small contracts (2026-10-28: 331
  `ContractNotice` vs 7 `SmallContractNotice` nationwide, all 7 with empty `cpvCode`, 3 without a
  deadline). A second source is a condition of product value for small firms (ROADMAP), and
  PR-04 matching must use title keywords (see the CPV gap below).
- Gaps handed to later PRs (Quality Review of Part B):
  - `htmlBody` (dropped in Part B) contains the buyer's contact e-mail and sometimes the order
    value (e.g. "Wartość zamówienia: 181300 PLN") — candidate for the PR-03 "HTML → text" step
    (description, contact, value); there is no structured value field in the listing.
  - CPV → MVP category mapping is still open; both captured small contracts have an empty
    `cpvCode`, so category matching may also need title keywords (PR-03/04).
  - `location` is the buyer's seat, not the place of performance — PR-04 region matching must
    take that into account.

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

2026-10-30, PR-02 Part B owner-review follow-up (Node 22.22.0, pnpm 10.28.0, PostgreSQL 16):

- Fixtures pseudonymised: 15 e-mails and 7 phone/fax numbers replaced (0 names); each file
  parses, every record deep-equals the capture except `htmlBody`, and the raw text outside the
  `htmlBody` values is unchanged.
- Code & Safety Review round 4: PASS; its one Low (page-size margin overstated as ~5×; worst case
  25 × 95.6 KB ≈ 2.4 MB, i.e. ~2× under 5 MB) fixed in the `BZP_PAGE_SIZE` comment and D-015.
- `TEST_DATABASE_URL=… REQUIRE_DB_TESTS=1 pnpm check` — format, lint, typecheck clean;
  512/512 tests passed (17 files), no test changed. No dependency changes.

2026-10-30, PR-02 Part B session (Node 22.22.0, pnpm 10.28.0, PostgreSQL 16):

- `TEST_DATABASE_URL=… REQUIRE_DB_TESTS=1 pnpm check` — format, lint, typecheck clean;
  512/512 tests passed (17 files; 72 new in Part B, after both review fix rounds). No dependency
  changes.
- All tests offline (captured fixtures + fake HTTP client); the live API was not called from
  the container (AC1 pending, see Blockers).

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
