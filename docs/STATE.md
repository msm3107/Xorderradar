# Current State

Current phase: PHASE 1 — DATA PIPELINE
Current PR: PR-03 — Ingestion, Normalization & Deduplication
Status: Part A (ingestion core) merged in PR #4 (head 6263cd8). The owner-review follow-up
round (docs, `tender_id`, lock busy → skipped, `health` schema check) arrived after the merge
and is in a follow-up PR; Code & Safety re-review PASS, Quality Review ACCEPT WITH NOTES (notes
applied); awaiting owner verification. Part B (BZP notice updates + normalization helpers) not
started.

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
- **PR-02 — First Source Adapter** (MERGED: Part A as PR #2, 5533384; Part B as PR #3, merge
  commit 184d31a). AC1 (real notices through SafeHttpClient) is still pending owner
  verification on a machine with direct egress (D-014) — see Blockers. Details:

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
  - **Part B — MERGED as PR #3 (184d31a); Code & Safety Review PASS (last: round 4 after the
    owner review), Quality Review PASS, owner GitHub review addressed.**
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

## In progress

**PR-03 — Part A (ingestion core)** — merged in PR #4; the owner-review follow-up round is in
a follow-up PR (Code & Safety re-review PASS, Quality Review ACCEPT WITH NOTES); awaiting owner
verification of that PR (scope split
recorded in `docs/PR_PLAN.md` → PR-03 „Podział”; acceptance criteria 1–4):

- `src/ingestion/fingerprint.ts` (D-016): `fingerprint` = SHA-256 of
  `JSON.stringify([sourceId, "external", externalId])`, or `[sourceId, "url", sourceUrl]`
  without an external id; `contentHash` = SHA-256 of `[field, value]` pairs in a fixed order
  (dates ISO, nested keys sorted, `null`/`""`/absent distinct; no `fetchedAt`/`sourceId`).
  Deferred: the variant for sources with neither an id nor a stable URL.
- `ingestOpportunity` (`opportunities-repository.ts`, D-017): conditional
  `ON CONFLICT … DO UPDATE … WHERE same source AND content_hash IS DISTINCT FROM`, then a
  `SELECT` → `inserted`/`updated`/`unchanged` (no write; `fetched_at`/`updated_at` not
  refreshed, no `last_seen_at`) or `DomainError duplicate` for another source.
  `upsertOpportunity` unchanged in behaviour.
- Migration `0002_ingestion_runs`: table with named CHECKs, FK, index
  `(source_id, started_at DESC)`; seeds `bzp` with `ON CONFLICT DO NOTHING`.
  `recordIngestionRun` repository; `IngestionRunSummary` schema in `src/domain/ingestion-run.ts`.
- `runIngestion` (`src/ingestion/run.ts`): enabled DB sources × registry; sequential, isolated
  per source; streaming via the new optional `FetchContext.onDocument` (BZP adapter streams
  pages, bounded memory, D-008); per-record rejections (normalize or `DomainError`) counted and
  logged, other write errors fail the source; records stored before a failure stay; per-source
  timeout 10 min combined with the run signal (D-018); enabled source without adapter →
  `failed`/`no_adapter` (D-020); each run stored in `ingestion_runs` and logged.
- CLI `ingest [sourceId...] [--date YYYY-MM-DD] [--limit N]` (default yesterday UTC, 1000 per
  notice type, max 1000) under a session advisory lock on a dedicated connection (D-019);
  busy → `status: "skipped"`, exit 0, nothing fetched (owner review change, was exit 1); no
  auto-migrate (any pending migration → exit 1); JSON summary on stdout; exit 0 when all
  sources `succeeded`/`incomplete`, 1 otherwise, 2 for usage errors.
- Tests: fingerprint/contentHash and ingest CLI unit tests, BZP streaming tests, integration
  tests on PostgreSQL (two runs → no duplicates / all unchanged; changed deadline/title →
  updated with id and `first_seen_at` kept; failing source isolated; lock held / concurrent
  runs; run summary stored and logged; per-record `DomainError`; fetch error and timeout after
  stored records; BZP end-to-end on fixtures with a fake HTTP client; migration 0002 idempotent,
  seed does not overwrite, CHECKs enforced).
- Docs: ARCHITECTURE (header, §2, §4.1, §4.3, §5, §6, §7), DECISIONS D-016…D-020, README
  (`ingest`, cron), SECURITY (§4, §12).
- Code & Safety Review: PASS with findings; fix round 1 done (awaiting re-review):
  - M1: every pooled connection gets an `error` listener (+ TCP keepalive), so a terminated
    lock connection no longer crashes the process; the lock connection is checked every 5 s
    and a failed check aborts the run (`lock_lost`, exit 1, JSON summary still printed,
    remaining sources not started); a failed unlock is logged and keeps the result (D-019).
  - M2: concurrent `ingestOpportunity` of one fingerprint tested (identical → inserted +
    unchanged; different hashes → inserted + updated; one row). The test exposed a real race:
    the concurrent INSERT can hit `UNIQUE (source_id, external_id)` instead of the
    `ON CONFLICT` arbiter; `ingestOpportunity` now retries once in that case (D-017).
    `upsertOpportunity` (PR-01, not used by ingest) has the same race; left unchanged.
  - L1–L3: no polling in the concurrency test (`started` promise, gate released in `finally`);
    run-not-recorded path tested (log carries the SQLSTATE code only); DB CHECK
    `ingestion_runs_error_code_status_check` in 0002. L4 and the cron-line nit: docs only.
- Code & Safety re-review: PASS; fix round 2 (optional Lows): L5 JSDoc moved onto
  `fingerprintOfOtherSource`; L6 deterministic test of the `ingestOpportunity` retry (a
  test-only trigger raises the `(source_id, external_id)` unique violation on the first
  attempt only). An open blocking transaction cannot force that path: the fingerprint arbiter
  precheck waits for it and takes the conflict path.
- Code & Safety Review round 3: PASS, no findings (fingerprints matched; `pnpm check` 614/614;
  ingestion integration files 52/52 ×5).
- Quality Review: ACCEPT WITH NOTES (AC1–AC4 met). Doc round: R1 (ARCHITECTURE header: Part B
  = normalization helpers only), R2 (this status) and notes N1–N6 applied (README re-run with
  `--date`, `ingest.log`, enabling sources; `content_hash` change only affects re-fetched rows;
  PR-03B/04/05 notes below).
- **Owner review of 6263cd8 (PR #4): PASS with doc asks + suggestions.** The owner queried the
  live API once via proxy (2026-10-28; facts below and in D-015). Follow-up round:
  - Taken into this PR:
    - docs: live facts in D-015, STATE, PR_PLAN (PR-03B scope/AC, AC2 caveat, PR-05 caveat),
      ARCHITECTURE;
    - `tenderId` stored: domain field (`text(200)`, nullable), BZP mapping (missing / blank /
      non-string / too long / malformed Unicode / control characters → `null`, record kept), migration `0003_opportunities_tender_id`
      (nullable `tender_id text`, non-unique partial index `(source_id, tender_id)`), appended
      to the end of the `content_hash` field list (D-016; fingerprint unchanged);
    - lock busy is not an error: `{"status":"skipped","reason":"lock_busy",…,"runs":[]}`,
      exit 0, no `ingestion_runs` row, `ingest lock busy` warn kept; lock lost stays exit 1
      (D-019);
    - `health` checks migrations: field `schema` (`ok` / `error` + `not_migrated` + `pending`
      names / `not_checked` when the database itself failed), overall `error` if either check
      fails. Shared with `ingest`: `pendingMigrations` reads the `kysely_migration` ledger
      (read-only; no ledger created, no migration lock) instead of
      `to_regclass('ingestion_runs')` — the old check would have let a database at `0002` (no
      `tender_id`) through (D-020).
  - Planned, not in this PR: `NoticeUpdateNotice` handling (PR-03B); catching up missed days
    (`--from/--to` or automatic since the last `succeeded` run) — candidate in PR_PLAN PR-03B,
    to be confirmed by the owner.
- Review of the owner-review follow-up round:
  - Code & Safety Review: PASS with 2 Low, both fixed: L1 a `tenderId` with a control
    character (e.g. NUL, which PostgreSQL rejects in `text`) → `null` instead of a rejected
    notice (+ test values `\u0000`, `\u0007`, `\u007f`); L2 the read-only `health` test also
    asserts that `kysely_migration_lock` is not created. Re-review: PASS.
  - Quality Review: ACCEPT WITH NOTES; doc round applied: R1–R3 PR-03B in `docs/PR_PLAN.md`
    (a deadline taken from a `NoticeUpdateNotice` survives re-ingesting the original; update
    notices are not stored as their own offers; the latest published update wins, and the
    row to update when several share `(source_id, tender_id)` is an explicit open decision),
    N1 (this status), N2 (`tenderId` → `null` cases), N3/N5 (README: `ingest` exit 1 cases;
    monitor freshness by the newest `succeeded` run), N6 (cancellation notices, open question
    below).

## Blockers

- **AC1 (real notices via `source:preview`) cannot be verified in the session container:**
  the owner already verified the adapter loop against the live API through the container proxy
  (2026-10-28: 15 requests, 338 records, 0 rejected, `incomplete` `[]`), but AC1 still needs the
  SafeHttpClient run itself, outside the container. The container has proxy-only egress and
  SafeHttpClient ignores the proxy by design (D-014). Owner runs, on a machine with direct
  outbound HTTPS, with a real, monitored contact of the operator and a past weekday:
  `CRAWLER_CONTACT=<twój-monitorowany-kontakt> DATABASE_URL=postgres://… pnpm dev source:preview bzp --date 2026-10-29 --limit 25 | jq .`
  and records "AC1 verified by owner outside the container" with the counts. PR-02 was merged
  with AC1 still open; it stays open until the owner records it.

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

- Open owner question (affects the `ingest` cron and PR-07): will the production cron host have
  direct outbound HTTPS? If production is proxy-only too, CONNECT-proxy support needs a D-014
  revision. The same applies to running `ingest` against the live API.

## Decisions made

See `docs/DECISIONS.md` (D-001 … D-020). D-007 and D-009 accepted in PR-01; D-014 (HTTP client
on `node:https` with pinned lookup, no HTTP library) accepted in PR-02 Part A; D-015 (first
source: BZP through the official API) in PR-02 Part B; PR-03 Part A: D-016 (fingerprint and
`content_hash` format), D-017 (`unchanged` writes nothing, no `last_seen_at`), D-018 (ingest
limit 1000 per notice type, 10-min source timeout, streaming), D-019 (advisory lock), D-020
(source selection and configuration errors). The PR-03A owner-review round amended D-015
(notice-update limitation, `tenderId` mapping), D-016 (`tenderId` in `content_hash`), D-019
(lock busy → skipped, exit 0) and D-020 (readiness = no pending migrations) without new IDs.

## Next action

1. Owner verifies the PR-03A follow-up PR (owner-review round after PR #4 was merged; Code &
   Safety re-review PASS, Quality Review ACCEPT WITH NOTES).
2. Owner verifies PR-02 AC1 outside the container (command and checklist under Blockers); a
   first live `ingest bzp --date <past weekday>` on the same machine is a useful follow-up
   check (exit 0, `inserted` > 0, a second run all `unchanged`).
3. PR-03 Part B — BZP notice updates (`NoticeUpdateNotice` linked by `tender_id`, new
   deadline from `htmlBody`, never guessed; see the notes below and `docs/PR_PLAN.md`) and
   normalization helpers (`docs/PR_PLAN.md` → PR-03 „Podział”): whitespace,
   HTML → text from `htmlBody` (description, contact, value), dates in Europe/Warsaw,
   voivodeships/counties, category dictionary (CPV → MVP categories), invalid published e-mail
   → `contact.raw` instead of rejecting the notice, pseudonymised HTML fixtures. Note: adding
   description/contact/value changes `content_hash`, but only rows fetched again become
   `updated` (D-016). The daily cron fetches only yesterday, so older rows are neither marked
   nor enriched: Part B must document a backfill step (`ingest --date …` for every publication
   day whose notices still have open deadlines). Backfill re-ingests the originals with their
   original `submittingOffersDate`, so it must not undo a deadline already taken from a later
   `NoticeUpdateNotice` (PR-03B AC4), and it must also cover the update notices of those days
   (the latest published update wins, AC5).
4. Open points carried from D-015/PR-02 for PR-03: whether the API's publication-day boundary
   is UTC or Polish time (cron at ~06:00 Europe/Warsaw ingests yesterday UTC; overlapping days
   are harmless thanks to dedup) — verify on the first live runs.
5. Open question for PR-03B/PR-05 (Quality Review N6): BZP cancellation notices (a tender
   withdrawn → status `cancelled`) have no plan item yet. Without one the digest may show
   cancelled tenders as open; decide in PR-03B whether to fetch and apply them like
   `NoticeUpdateNotice` (by `tenderId`), or record the limitation for PR-05.
6. Deferred in Part A: fingerprint variant for sources with neither an external id nor a
   stable URL (D-016; with the first such source); `last_seen_at` (D-017; when a feature needs
   it, e.g. detecting withdrawn notices).

Notes from the Part A Code & Safety Review (for the Quality Review and later):

- `status` is part of `content_hash` and BZP derives it from `fetchedAt` (deadline passed →
  `closed`), so re-ingesting a notice after its deadline reports `updated` once. Intended: the
  stored state of the offer changed (D-016, D-017).
- **BZP notice updates (owner's live query, 2026-10-28; D-015):** changes to a published
  notice come as a separate notice type, `NoticeUpdateNotice`, which `ingest` does not fetch.
  At least 100 that day (`PageSize=100` returned a full page; 331 `ContractNotice` the same
  day); in 96 of 100 the `htmlBody` concerns the offer submission deadline. An update notice
  has its own `noticeNumber` and links to the original only through `tenderId`
  (`ocds-148610-…`, present in 100/100); its `submittingOffersDate` is `null` — the new
  deadline is only in `htmlBody`. All 100 had the suffix `/01`; the risk of a new version of
  the original as `…/02` is not confirmed.
  - **PR-03A AC2** (change detected as `updated`) is met mechanically, but for BZP it will not
    happen in production — it depends on PR-03B (scope and AC in `docs/PR_PLAN.md`).
  - **PR-05 must not rely on the stored `deadline` for BZP before PR-03B lands:** "skip
    notices past their deadline" would drop tenders whose deadline was extended.
- **PR-04/05:** the stored `status` stays `open` after the deadline for rows that are never
  re-fetched, so matching and the digest must decide "still open" from `deadline` vs now, not
  from the stored `status`.

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
  of commit bf74ad9 (pseudonymised later in 22744c7). PR #3 was merged with a merge commit
  (184d31a), so bf74ad9 **is part of the base branch history**, not only of PR #3. Removing it
  would need a history rewrite, which requires the owner's explicit consent; the owner chose
  "no rewrite, only a new commit".
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
  - ~~`health` reports `ok` on a reachable but un-migrated DB~~ — closed in PR-03A (owner
    review follow-up): `health` reports pending migrations in `schema` and exits 1.
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

2026-10-30, PR-03 Part A owner-review follow-up (docs, `tender_id`, lock busy → skipped,
`health` schema check; Node 22.22.0, pnpm 10.28.0, PostgreSQL 16):
`TEST_DATABASE_URL=… REQUIRE_DB_TESTS=1 pnpm check` — format, lint, typecheck clean; 625/625
tests passed (21 files; before: 614). After the Code & Safety Review L1/L2 fixes (control
characters in `tenderId` → `null`; `health` creates no `kysely_migration_lock`) and the
Quality Review doc round (docs/README only): still 625/625. `pnpm build` clean; built
`health` on a database migrated only to `0001` → `schema` `not_migrated` with the pending names, exit 1. No
dependency changes. Existing tests changed only where the contract changed on purpose:
busy-lock assertions (exit 0 + skipped report), exact migration lists (+ `0003`), health
reports (+ `schema`), the BZP mapped-field allowlist (+ `tenderId`), the `runIngestion`
"schema not ready" setup (migrate only 0001 / 0001–0002 instead of dropping `ingestion_runs`
— the ledger check trusts the ledger) and the base-database health tests (now on a migrated
per-file schema, since `radar_test` itself is not fully migrated).

2026-10-30, PR-03 Part A doc round (R1, R2, N1–N6; docs/README only):
`TEST_DATABASE_URL=… REQUIRE_DB_TESTS=1 pnpm check` — format, lint, typecheck clean; 614/614
tests passed (21 files).

2026-10-30, PR-03 Part A fix round 2 (L5, L6): `TEST_DATABASE_URL=… REQUIRE_DB_TESTS=1 pnpm
check` — format, lint, typecheck clean; 614/614 tests passed (21 files; 1 new).
`ingestion.test.ts` run 3 more times: 42/42 each. With the retry temporarily removed, the new
test fails with `duplicate` on `opportunities_source_external_id_key`; retry restored.

2026-10-30, PR-03 Part A fix round 1 (Code & Safety Review findings; Node 22.22.0, pnpm
10.28.0, PostgreSQL 16):

- `TEST_DATABASE_URL=… REQUIRE_DB_TESTS=1 pnpm check` — format, lint, typecheck clean;
  613/613 tests passed (21 files; 9 new). `pnpm build` clean. No dependency changes.
- `tests/integration/ingest-cli.test.ts` and `ingestion.test.ts` run 3 more times, then the
  full suite once more: all passed. With the pool's client `error` listener temporarily
  removed, the lock-loss test reports an unhandled `57P01` error, so the test covers the crash.
- Changed tests written in this PR (not merged anywhere): the `ingestion_runs_error_code_check`
  case now uses `status: "failed"`, so it still isolates that constraint after the new
  status/code CHECK; the concurrency test waits on a `started` promise instead of polling.

2026-10-30, PR-03 Part A Coder session (Node 22.22.0, pnpm 10.28.0, PostgreSQL 16):

- `TEST_DATABASE_URL=… REQUIRE_DB_TESTS=1 pnpm check` — format, lint, typecheck clean;
  604/604 tests passed (21 files; before: 512 in 17 files; 92 new). Full suite run 3 more
  times without a failure (timeout and concurrency tests). `pnpm build` clean. No dependency
  changes.
- Existing tests changed only where the contract changed on purpose: the exact migration lists
  in `tests/integration/migrations.test.ts` and `tests/integration/cli-database.test.ts` now
  include `0002_ingestion_runs` (and the table list `ingestion_runs`).
- Built CLI: `ingest --limit 0` → exit 2 with usage; `ingest` on an un-migrated database →
  `Ingest failed: Database schema is not up to date …`, exit 1, nothing fetched. No live
  network calls (all ingestion tests use fake sources or captured fixtures).

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
