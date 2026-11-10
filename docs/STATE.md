# Current State

Current phase: PHASE 4 — PILOT
Current PR: PR-10 — Wejście bez pułapek (UX/QOL series PR-10 – PR-13)
Status: PR-08 **MERGED in PR #14 (366618e)**. PR-09 **MERGED in PR #15 (42dd008)**. PR-10
(first PR of the UX/QOL series from the independent UX audit of 2026-11-06; plan in
`docs/PR_PLAN.md` → PR-10 – PR-13, `docs/LAUNCH_ROADMAP.md` → 3d) **READY** (Code & Safety
Review PASS, Quality Review ACCEPT), base branch merged in after PR #15; its PR opens for owner
review. Owner steps on the VPS for PR-08 (AC1, `bk` backfill, DEPLOY §6) remain in Blockers.

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

**PR-03 — Part C (normalization helpers; `docs/PR_PLAN.md` → PR-03C)** — MERGED in PR #7
(merge commit f41b49c). D-022 new; D-015/D-016 amended.

- Owner review of PR #7: PASS (live check: 500 `ContractNotice` + 86 `SmallContractNotice`,
  0 rejected). Its QoL suggestions are handled in docs only: D-022 now fixes the county
  comparison rule (`comparableText(normalizeCounty(x))` on both sides; "m. st." vs "m.st."
  variants are left to PR-04) and lists PR-04 requirements; `docs/PR_PLAN.md` PR-04 gains
  AC5 (explicit reason when the source has no county), AC6 (keyword matching for offers
  without CPV) and AC7 (county comparison + variant tests).

- Pure helpers in `src/sources/normalize/`: `whitespace.ts` (`cleanText`: `\p{Cc}` → space,
  bidi/zero-width characters removed, whitespace collapsed), `html-text.ts` (linear HTML → text
  scanner, moved from `notice-update.ts` unchanged in behaviour), `comparable.ts` (lower-case,
  no diacritics incl. ł/Ł, for matching), `regions.ts` (16 voivodeships, `woj.`/`województwo`
  prefixes, BZP province codes; county only normalized as text, never derived),
  `cpv-categories.ts` (`mvpCategoriesForCpv`, CPV prefix table → the 10 MVP categories;
  applied in PR-04, `categories` keep the CPV codes), `warsaw-time.ts` (moved from
  `src/sources/`).
- `src/sources/bzp/notice-body.ts`: offers (`ContractNotice`, `SmallContractNotice`) read
  `htmlBody` (≤ 1 000 000 chars) for description (4.2.2.)/3.3.), parts joined by a blank line,
  ≤ 10 000 chars cut at a word boundary with "…"), contact (e-mail 1.5.9.)/1.4.9.) lower-cased
  if valid, otherwise `raw`; phone 1.5.7.)/1.4.7.) ≤ 50 chars and with a digit, otherwise
  dropped) and estimated value (4.1.5.) or 3.4.) + 3.5) currency; exactly one label, strict
  format, 3-digit fraction refused, zero → `null`, ambiguous currency → both `null`). A field
  ends at a "SEKCJA" heading or a form label numbered ≥ its own. An unreadable body never
  rejects the offer (details `null`).
- Tests: `tests/normalize.test.ts`, `tests/bzp-notice-body.test.ts`, adapter/preview tests
  with real values from the fixtures, integration test: a re-fetched row becomes `updated`
  once, keeps a deadline set by an update notice, then `unchanged`.
- Reviews: C&S PASS with findings (M1 description cut at "1.1)" lines; L1 control/bidi
  characters; L2 phone without a digit; L3 published 0) → fix round → C&S re-review PASS;
  Quality Review REJECT (AC7: ARCHITECTURE did not record the `content_hash` consequence) →
  fix round (ARCHITECTURE §5, README backfill hint, D-022 wording, `4530` → instalacje,
  `50232` → elektryka) → C&S PASS with 3 Low (comment wording) → comment fix round → C&S
  PASS → Quality re-review ACCEPT.

**PR-03 — Part B (BZP notice updates + catch-up)** — MERGED in PR #6 (merge commit 1990231); Code & Safety Review PASS
with findings → fix round → C&S re-review PASS; Quality Review REJECT (documentation only,
AC1–AC9 met) → documentation fix round → C&S check PASS → Quality re-review ACCEPT; PR
opened for the owner's review (not merged). **Owner review round (PR #6) implemented; C&S
review FAIL → fix round → C&S re-review PASS → Quality Review ACCEPT; pushed to PR #6 for the
owner's re-review** (details at the end of this list). Owner
decisions: the update goes to the older row of `(source_id, tender_id)`; catch-up via
`--from/--to` and automatically without a day option; PR-03 split (B = updates + catch-up,
C = normalization helpers; only the Warsaw-local → UTC helper is in B).

- BZP adapter fetches a third type, `NoticeUpdateNotice` (last, same per-type limits),
  dispatching every record on its own `noticeType`; update records read only `noticeNumber`,
  `publicationDate`, `tenderId`, `htmlBody` (≤ 1 000 000 chars, longer → rejected; raised
  from 200 000 in the owner review of PR #6).
  `NormalizeResult` gains `kind` (`opportunity` | `notice_update`); `NoticeUpdate` domain
  schema (`src/domain/notice-update.ts`).
- `src/sources/bzp/notice-update.ts`: linear text scan of `htmlBody` (comments, script, style,
  attributes ignored; an unclosed tag, comment, script or style anywhere → rejected as
  `invalid source fields: htmlBody`); applies only a change of an
  "Ogłoszenie o zamówieniu" (3.1) with one 3.4.1.) / "8.1. Termin składania ofert" block, value
  after "Po zmianie:" as `YYYY-MM-DD HH:MM` Europe/Warsaw → UTC (`src/sources/warsaw-time.ts`;
  DST gap/overlap → rejected). Linked only by `tenderId` (section 3.2 unused, D-015).
- Migration `0004_notice_updates`: `opportunities.deadline_update_notice` /
  `deadline_update_published_at` (both null or both set) and `ingestion_runs.skipped`.
  `applyDeadlineUpdate`: one atomic `UPDATE` of the older row
  (`published_at ASC NULLS LAST, first_seen_at ASC, id ASC`) when the stored provenance is
  absent or older by `(published_at, notice number)`; result `updated` / `unchanged` /
  `skipped` (`no_original`, `superseded`). Upserts keep a deadline set by an update (AC4).
  Skips (`no_tender_id`, `not_contract_notice_change`, `no_deadline_change`, `no_original`,
  `superseded`) counted in `skipped` and logged at info without HTML.
- Catch-up (D-021, `src/ingestion/catch-up.ts`): `ingest --from/--to` (≤ 31 days, counted
  before any list is built; days in 2000–2999 only) and, without a day option, per source the
  uncovered days of the 31 ending yesterday UTC from the source's earliest run on (covered =
  `succeeded`/`incomplete` run started after the day ended; owner review of PR #6 — was "days
  after the last covered day"); fresh source → yesterday only; older missing days →
  `clipped`, never run automatically; after 2 consecutive failed first attempts (a retry of an
  already attempted day does not count) the source's remaining
  days are `notRun` (`consecutive_failures`; was: a failed day stops the later days). Report:
  `mode`, `from`, `to`, `runs[].publicationDate`, `runs[].skippedReasons`, `notRun`,
  `clipped`.
- `source:preview` lists updates (`noticeUpdates` count, `updates` list), never applies them.
- Docs: DECISIONS D-015 (amended), D-019 (busy report shape), D-021 (new); PR_PLAN (split,
  AC 7–9 for catch-up, PR-03C); ARCHITECTURE, README, SECURITY §8/§12, fixture README.
- Code & Safety Review: PASS with findings; fix round:
  - M1: `daysBetween` listed days before the 31-day check and never ended past year 9999
    (`"+010000-…"` sorts before `"9999-…"`), so `ingest --date 9999-12-31` hung under the lock.
    Now the span is counted arithmetically (`daySpan`) before any list is built (CLI and
    `runIngestion`), `daysBetween` loops on numeric time and throws above 31 days, catch-up
    compares day counts, and `ingest` accepts days in 2000–2999 only (`isIngestDay`; usage
    error otherwise; `source:preview` unchanged).
  - M2/L4: operator notes in D-015/D-021 and README (re-run the following days after a
    backfill so `no_original` updates get applied; manual `--date` of a later day after a
    failed day; a day that always fails).
  - L3: `textSegments` reports an early stop; an unclosed tag, comment, script or style
    anywhere now rejects the record (`invalid source fields: htmlBody`, warn) instead of a
    `no_deadline_change` skip.
  - L5: open item under Next action.
- Quality Review: REJECT on documentation only; fix round:
  - STATE header/In progress made consistent, the pre-PR-03B notes rewritten as post-PR-03B
    caveats for PR-05, a new Last verification entry.
  - README: the D-020/D-014 paragraphs moved back out of the operator-notes list; timeout and
    `--limit` described per source and day (also ARCHITECTURE §4.3/§6, SECURITY, D-021);
    first-deployment recipe in "Cron"; the two meanings of "skipped" defined.
  - Small contracts: both captured `SmallContractNotice` originals have `tenderId` = `null`, so
    no update can be linked to them — recorded in D-015 and Next action item 6.
  - `clipped[].firstSkipped/lastSkipped` renamed to `from`/`to` (code, tests, D-021, README,
    ARCHITECTURE); the `ingest` usage text defines a covered day; D-015 wording ("do PR-03B
    nie pobierał").
- Owner review of PR #6 (f356815) — round implemented, C&S review FAIL, fix round below:
  1. `htmlBody` bound 200 000 → 1 000 000 chars (a live body of 255 562 was rejected);
     linear-time tests at 1 000 000 for the hostile inputs.
  2. Gap-based catch-up (`planCatchUp`, `catchUpHistory`: one query per source, no
     migration) and `consecutive_failures` after 2 failed days in a row
     (`INGEST_MAX_CONSECUTIVE_FAILED_DAYS`, all modes); D-021 notes on `--date` and an
     always-failing day resolved; PR_PLAN AC8–AC9 amended.
  3. README: first deployment = one-off `ingest --from <wczoraj−30> --to <wczoraj>` before
     the first cron.
  4. `runs[].skippedReasons` in the `ingest` report (in memory only; sums to `skipped`).
- C&S review of that round: FAIL; fix round (C&S re-review PASS; Quality Review ACCEPT,
  doc nits applied by the coordinator: README legend of skip reasons, oldest backfill day
  leaves the window, out-of-order retry → `no_original` note in README/D-021, D-021 "at most
  2 (usually 1)"):
  - H1: `.normalize("NFC")` is quadratic in a run of combining marks (80 000 chars ~2 s);
    now only segments ≤ `MAX_NORMALIZED_SEGMENT_LENGTH` (256) are normalized — longer ones
    can never equal a label (≤ 65 chars) or the date and are kept as they are. Tests at
    1 000 000 chars of U+0316/U+0301 (bare, in one element, segments at the bound).
  - M1: the 2-in-a-row limit counts only failed **first attempts** (no earlier run of the
    source for that day, from `catchUpHistory.attempted`, also queried in `--date`/`--from/--to`
    mode); a failed retry neither counts nor resets (`failureStreak`). Two days that keep
    failing no longer block newer days.
  - L1: `BZP_PAGE_SIZE` comment (update bodies up to 1 000 000 → a page can exceed 5 MB →
    `too_large`, a day that keeps failing, now non-blocking). L2: an unrecorded run counts as a
    failed first attempt (test). N1–N2: comment wording; dates via `to_char`. N3: any run of
    an old day (also `--date`, even failed) moves the catch-up lower bound (README, D-021).

**PR-03 — Part A (ingestion core)** — merged in PR #4; the owner-review follow-up round
merged in PR #5 (e71decc) (scope split
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
- **PR-04 — Matching Engine** (`docs/PR_PLAN.md` → PR-04, AC1–AC7) — **MERGED in PR #8
  (merge commit f8f113a)** after the owner's re-review. D-023 new (rules, profile schema,
  `match:preview`).

  - `src/matching/` (pure, no network/LLM; ESLint import allowlist: only `domain` and
    `sources/normalize`, pinned by `tests/matching-dependency-guard.test.ts`):
    - `match.ts` — `matchOpportunity(offer, profile)` → `{ score, matched, reasons }`. Points:
      category +40 (`mvpCategoriesForCpv` ∩ profile categories), first keyword +30, more than one
      keyword +10, region +20, each exclude −100. `matched` = score ≥ 50, no exclude, region not
      `mismatch`. Missing CPV → reason "brak CPV — kategoria niesprawdzalna" (AC6; since PR-05:
      "kategoria: ogłoszenie nie podaje kodu CPV").
    - Region is three-valued (`match` / `mismatch` / `unknown` with an explicit reason), checked
      in this order (D-023, changed 2026-10-31 after the owner's review): no regions in the
      profile → +20 "bez ograniczeń"; no location → unknown (AC3); a known offer voivodeship
      outside the profile's voivodeships → mismatch whatever the county (counties never widen a
      profile with voivodeships); a known listed county → match; a listed voivodeship → match;
      otherwise unknown (no offer voivodeship while the profile lists voivodeships, or "źródło nie podaje powiatu", AC5) or mismatch. Narrowing by county
      inside a listed voivodeship is not implemented (no source gives counties yet); a
      counties-only profile gets BZP offers from the whole country as unknown, and
      `profile:create` warns about it. Counties compared by `countyKey` (`comparableText(normalizeCounty(…))`, "m. st." /
      "m.st." / "miasto stołeczne" / "(miasto na prawach powiatu)" variants; AC7).
    - `text.ts` — tokenizer and phrase search on `comparableText`: consecutive tokens; tokens
      ≥ 4 letters match by stem (one final vowel dropped) as prefix; number and short tokens
      exact only. Keyword de-duplication by maximum bipartite matching (each counted keyword has
      a hit of its own; profile order; hit lists capped at the number of keywords).
    - `format.ts` — Polish reason texts.
  - `src/domain/vocabulary.ts` — `MVP_CATEGORIES`, `VOIVODESHIPS` (old exports kept as
    re-exports). Profile schema: categories from the MVP list (≥ 1), canonical voivodeships,
    keywords with a letter or digit and ≤ 10 tokens. Stored profiles are validated on read
    (breaking rows → `invalid_stored_row`, fixed by hand; no `profile:update` yet).
    `comparableText` drops `\p{Cf}` (soft hyphen).
  - Repositories: `listMatchCandidates` (no `cancelled`/`closed`,
    `published_at DESC NULLS LAST, id ASC`, limit; returns `{ offers, skipped }` — invalid
    stored rows are skipped per row, the owner's PR-01 rule); `updateCompanyProfile` in one
    transaction.
  - CLI (`src/profile-commands.ts`): `profile:create <file.json>` (regular file, ≤ 64 KiB,
    strict UTF-8, per-field messages without values; exit 2 bad file/profile, 1 duplicate
    e-mail), `profile:show <id>`, `match:preview <id> [--limit N]` (default 100, max 1000;
    deadline first, null last, past deadlines last with "(po terminie)"; summary "dopasowane X z
    Y", skipped rows counted and logged by id; never prints contact data). README has a
    copy-paste example profile (tested).
  - Reviews: C&S PASS with findings (M1 region hid a mismatching voivodeship; M2 update could
    write then throw; L1 number prefix match; L2 duplicate inflections; L3 cost; L4 unknown key
    as "(root)"; L5 FIFO/symlink tests) → fix round → C&S PASS (N1: de-duplication looked only
    at the first hit) → fix (maximum matching; also a flaky integration test made deterministic)
    → C&S PASS → Quality ACCEPT WITH NOTES (R1 STATE; O1 past deadlines; O2 per-row skip; O3
    error texts; O4 README example; O5/O6 docs) → fix round → C&S PASS (L-a zod `invalid_type`
    can print "Infinity"; L-b `--limit` counts skipped rows) → follow-up → C&S PASS → Quality
    re-review ACCEPT → PR #8.
  - Owner review of PR #8 (2026-10-31): Medium — with "mazowieckie + powiat warszawski zachodni"
    36 offers matched, 20 outside mazowieckie (region unknown, BZP gives no county) → fixed by
    the region order above. QoL done: `profile:create` warns (stderr, exit 0) about counties
    without voivodeships, keywords that only match their exact form (< 4 characters; advice: add
    a longer stem next to the short word) and no include keywords (small contracts have no
    CPV). Owner-round reviews: C&S PASS (M1: docs claimed narrowing the code did not do → code
    now never widens, docs state the exact rule) → C&S PASS (L1 wording) → Quality ACCEPT WITH
    NOTES (STATE lines; "replace" advice would lose noun forms) → fixes.
  - Owner decisions still open (D-023): threshold 50; region `mismatch` rejects whatever the
    score; narrowing by county inside a listed voivodeship (decide when a source gives
    counties); counties-only profiles match nationwide as unknown (warned) — confirm before
    PR-05 e-mails; stem rule (phrases need consecutive tokens; "auto" exclude
    also removes "Automatyka"); validation on read; maximum-matching de-duplication (only affects
    the +10 bonus and reason lines, never `matched`).

- **PR-05 — Alert / Daily Digest** (`docs/PR_PLAN.md` → PR-05, AC1–AC4) — **MERGED in PR #9
  (merge commit 0537d2c)** after the owner's review. D-010 Accepted (SMTP through nodemailer),
  D-024 new (digest rules, idempotency, failure classes, operator procedure for `pending` rows).

  - `digest [--dry-run] [--profile <id>]` (`src/notifications/run.ts`, CLI in `src/cli.ts`): one
    JSON summary on stdout, exit 0 = ok / nothing to send / lock busy, exit 1 = any profile
    failed, uncertain, `not_found`, `invalid_profile`, `not_run`, or a schema/DB problem. A stderr
    line counts `pending` deliveries that need an operator decision (README „Wynik niepewny”).
  - Eligibility: status not `closed`/`cancelled`; `deadline` null or ≥ now; first seen within 7
    days; ≤ 10 000 candidates; invalid stored rows skipped per row and counted. ≤ 50 offers per
    e-mail, soonest deadline first; the overflow is announced under the heading and goes out on
    the next days.
  - `deliveries` (migration `0005_deliveries`): unique `(profile_id, opportunity_id, transport)`,
    status `pending`/`sent`/`failed`, attempts ≤ 3, safe `error_code` CHECK. At most once: a
    profile with a `sent` or `pending` row on the Warsaw day is skipped; rows are claimed in one
    committed transaction before sending; `pending` rows (crash or uncertain outcome) are never
    resent automatically. Shared `withAdvisoryLock` (`src/infrastructure/db/advisory-lock.ts`,
    extracted from the ingest lock).
  - E-mail (`src/notifications/digest.ts`, pure): subject with count and profile name only;
    text + HTML, every source value escaped, links only http(s), missing values „nie podano”
    (never invented); footer with the reason, the deadline/cancellation caveat and how to
    unsubscribe (reply or operator sets `active=false`; token link in PR-06).
  - Senders (`src/notifications/sender.ts`): `test` (default) writes `.eml` + `.json` to
    `EMAIL_OUTBOX_DIR` (0700/0600, all-or-nothing); `smtp` only with `EMAIL_MODE=smtp`,
    `EMAIL_FROM`, `SMTP_URL` (smtps:// or smtp:// with STARTTLS required), TLS ≥ 1.2, timeouts,
    one connection per message. Failure classes `transient`/`permanent`/`unreachable`/`setup`/
    `uncertain`: setup, exhausted unreachable and uncertain stop the run without spending
    attempts; the rest of the profiles become `not_run`.
  - Dependency: `nodemailer` 10.1.7 (MIT-0, no deps). Published 2026-10-18; the owner accepted
    its age and checked the lockfile integrity in the PR #9 review; < 10.1.4 has addressparser
    advisories.
  - Owner-review round of PR #9: every e-mail (SMTP and the test-mode `.eml`) carries
    `List-Unsubscribe: <mailto:<EMAIL_FROM>?subject=wypis> (Wypisz)` (RFC 2369) built by the
    shared `mailOptions`/`unsubscribeMailto` in `src/notifications/sender.ts`: only the bare,
    strictly validated address (no display name), local part and domain percent-encoded, header
    left out when the address is not one plain address; nodemailer also strips control
    characters and `<>`. Tests cover the header line, the `.eml`, 11 address cases and a CRLF
    Bcc injection. One-click unsubscribe (RFC 8058 `List-Unsubscribe-Post`) → PR-06. C&S PASS;
    optional L-1: the README header example omits the ` (Wypisz)` comment.
  - Reviews: C&S PASS (M1 SMTP setup failures not stopped — N logins and attempts spent; L1
    EHOSTUNREACH/ENETUNREACH uncertain; L2 kept, documented; L3 partial outbox files; L4 Markdown
    code spans) → fixes → C&S PASS (L-A CONN reply at close ≠ setup; L-B 421 → unreachable) →
    Quality ACCEPT WITH NOTES (cancellation caveat, pending visibility, overflow placement, CPV
    wording, missing link) → fix round 2 → C&S PASS (M-1 refused EHLO under STARTTLS classified
    permanent) → fix round 3 → C&S PASS.
  - Owner decisions open (nodemailer age: accepted by the owner): explicit confirmation
    before any real `smtp` send; 50 per e-mail (Quality asks 20–30?); skip offers due within
    24–48 h?; is reply-to-unsubscribe enough before PR-06 (sender identification,
    `List-Unsubscribe`)?; plan item for BZP cancellation notices before the pilot; coder
    deviations listed in D-024 (in-run retry only for not-delivered errors, `pending_today` skip,
    `unreachable` class, uncertain stops the run, `send_*` error codes).

- **PR-06A — Dostęp do profilu** (`docs/PR_PLAN.md` → PR-06A; first part of PR-06) —
  **MERGED in PR #10 (merge commit 558b226)** after the owner's review. D-025 new (web server on
  `node:http`, no framework), D-026 new (e-mail tokens, cookie session, CSRF, one-click
  unsubscribe); D-024 amended (digest footer links and `List-Unsubscribe` https + mailto).

  - `serve` (`src/web/server.ts`): one process, `WEB_HOST` (default 127.0.0.1) / `WEB_PORT`
    (default 3000), `PUBLIC_BASE_URL` required (https; http only on loopback outside
    production). Routes: `/`, `/dostep/<token>` (GET confirm page, POST log in → 303 `/profil`),
    `/profil`, `/profil/wypisz`, `/wyloguj`, `/wypis/<token>`, `/styl.css`. Server-rendered
    Polish pages, no JavaScript, shared `escapeHtml` (`src/infrastructure/html.ts`).
  - Tokens (`src/infrastructure/db/access-repository.ts`, migration `0006_access`:
    `access_tokens`, `sessions`): 256-bit base64url, stored only as SHA-256. Login: single use,
    7 days, consumed by a conditional `UPDATE … RETURNING` with the session created in the same
    transaction (5-way race tested). Unsubscribe: multi-use, 60 days. Every unknown, used,
    expired, malformed or wrong-purpose token gets the same neutral 404 page.
  - Session: cookie `__Host-radar_sesja` (HttpOnly, Secure, SameSite=Lax, Path=/, 30 days),
    new id on every login, logout by POST, expiry checked server-side, `ON DELETE CASCADE`.
    CSRF: HMAC-SHA256 of the session secret, `timingSafeEqual`; Origin check (missing passes,
    `null`/foreign → 403) on every route except `/wypis/<token>`.
  - One-click unsubscribe (RFC 8058): POST `List-Unsubscribe=One-Click` as urlencoded or
    multipart (own bounded parser, `src/web/multipart.ts`), 200 with no redirect and no cookie.
    The digest adds a "Twój profil" link and the unsubscribe link to the footer, plus
    `List-Unsubscribe: <https…>, <mailto…>` and `List-Unsubscribe-Post` when `PUBLIC_BASE_URL`
    is set; without it the e-mail is byte-identical to PR-05. Tokens are issued before
    `claimDeliveries`; a dry run issues none. The outbox `.json` copy shows the links as
    `[token]`; the `.eml` keeps them (secret).
  - `access:link <profileId>`: prints the login link on stdout, a "secret" warning on stderr.
  - `access:revoke <profileId>` (owner review of PR #10): deletes every access token (login and
    unsubscribe) and every session of the profile in one transaction (tokens first), prints
    only `{"status":"ok","tokens":N,"sessions":M}`; profile and notifications untouched; no
    `PUBLIC_BASE_URL` needed; unknown profile → 1. Tenant isolation tested end to end.
  - Hardening: 8 KB body (413), urlencoded only (415; multipart only on `/wypis`), headers
    10 s / request 15 s (`connectionsCheckingInterval` 1 s), 8 KB headers, Host required; CSP,
    nosniff, no-referrer, no-store; hourly cleanup of expired rows in batches of 1000; graceful
    shutdown with a 10 s force-close. Logs: method, route name, status, duration; a client abort
    is `http request aborted` (info, route + reason only).
  - Pages tell the customer how to get back in (reply to the last e-mail → operator sends a new
    link) and how to undo an unsubscribe; README „Obsługa klienta” gives the operator the
    `access:link`, `access:revoke` and `UPDATE company_profiles SET active = true` steps, plus a
    psql `\prompt` lookup of `profileId` by e-mail (safe for an apostrophe in the address).
  - No new dependencies.
  - Reviews: C&S PASS (M-1 outbox `.json` held token links contrary to the docs; L-1 Node checks
    the timeouts every 30 s by default; L-2 client aborts logged as DB failures; L-3 literal
    §8.3 framing → 400; L-4 IDN note wrong) → fix round (redaction, 1 s check interval,
    `RequestAbortedError`, docs) → C&S PASS (live probes: header 10.01 s, body/drip 15.01 s) →
    Quality ACCEPT (should-fix: re-entry sentence, way back after unsubscribe; README operator
    note) → copy round → C&S PASS → Quality ACCEPT. Owner review of PR #10: PASS, no blockers;
    follow-up `access:revoke` → C&S PASS → Quality ACCEPT (should-fix: say that old one-click
    links stop working; D-026 line; e-mail lookup) → polish round → C&S PASS (L-1: an apostrophe
    broke the lookup literal) → README `\prompt` fix → C&S PASS.
  - PR-06B acceptance criteria added from the owner's review (`docs/PR_PLAN.md`): „Włącz ponownie
    powiadomienia” on `/profil` (POST + CSRF); login-CSRF protection on `POST /dostep`
    (`Sec-Fetch-Site`/`Origin`) before the profile form accepts data; an e-mail change revokes the
    profile's other sessions and tokens (needs a `revokeProfileAccess` variant that keeps the
    current session).
  - Owner decisions open: TTLs (login 7, unsubscribe 60, session 30 days); a self-service
    "e-mail me a link" form (needs anti-enumeration and rate limiting); leniency for the literal
    RFC 8058 §8.3 example framing on `/wypis` only (body has no security role there; strict
    RFC 2046 today); send the "Twój profil" link to customers before PR-06B or keep
    `PUBLIC_BASE_URL` unset until then; forwarded digest e-mails give profile access (footer
    warns; separate rarer login e-mail?); the inactive-profile sentence was changed from „Aby je
    włączyć, napisz do operatora serwisu.” to the reply-to-last-message wording.

- **PR-06B — Ekrany klienta** (MERGED in PR #11, merge commit 2ef7c20; second part of PR-06). D-027 new (customer screens, e-mail change, matches
  list, login-CSRF); D-025 amended (`Referrer-Policy: strict-origin`).

  - **PR-06A bug fixed here:** `Referrer-Policy: no-referrer` made real browsers send
    `Origin: null` on form POSTs, which the PR-06A Origin check refuses with 403 (login, logout,
    unsubscribe from `/profil`). Header and meta tag are now `strict-origin` (WHATWG Fetch).
  - Routes (`src/web/server.ts`): `GET/HEAD/POST /profil/ustawienia` (urlencoded ≤ 64 KB / 64
    pairs, only this route; others stay 8 KB), `POST /profil/wlacz`, `GET/HEAD /dopasowania`.
    Profile only from the session; CSRF checked before form validation (missing/duplicate → 403);
    unknown fields (e.g. `active`) → 400.
  - Form (`src/web/profile-form.ts`): Polish per-field errors with a linked summary, line-numbered
    keyword/county errors, county names checked with `countyKey` (same rule as `profile:create`);
    counties hint says honestly that offers carry no county yet. Domain schema
    `companyProfileSettingsSchema` (no `active`).
  - E-mail change (`updateProfileSettings`): one transaction — profile `FOR NO KEY UPDATE`, the
    kept session re-checked (`FOR KEY SHARE`, unexpired; else 401, nothing written), then tokens
    and other sessions deleted, then the profile UPDATE; one retry on 40P01 for the hourly cleanup.
    Cycle-free against login, logout, `access:revoke` (now locks the profile first) and digest
    token issue (tested with paused transactions and a timing assertion). No verification of the
    new address (owner decision); repeat field required.
  - `/dopasowania`: same rules as the digest (`src/notifications/candidates.ts`: 7 days, 10 000
    candidates), ≤ 50 offers, soonest deadline first, reasons and source link; includes offers
    already e-mailed (stated on the page). `matchingItems` yields after ~20 ms of work (worst
    event-loop stall measured ≤ 73 ms with a maximal profile and 5 000 candidates). One computation
    per process (`src/web/matches-slot.ts`, owner round): a concurrent request waits in a FIFO
    queue (≤ 8 waiters, ≤ 3 s, slot handed straight to the oldest waiter); a full queue or a timed
    out wait gets 503 + `Retry-After: 5`; a waiter whose client disconnects leaves the queue and
    nothing is computed for it; no result cache (D-027). Compact cards: title, buyer, location,
    deadline, reasons and source link visible; publication date, category, description and
    contact inside `<details>` („Szczegóły ogłoszenia”, no JS).
  - `/profil` always shows „Adres powiadomień” (escaped, from the DB via `getProfileStatus`); after
    an e-mail change the notice asks to check it. The old address is not shown (it would have to
    travel in a cookie, URL or column; D-027 rejected alternatives).
  - Digest: short HTML link texts „Otwórz swój profil” / „Wypisz się z powiadomień”; tokens issued
    only while the profile still has the address being sent to (`issueDigestTokens`), else status
    `address_changed` (exit 0, next run sends to the new address).
  - One-shot notice cookie `__Host-radar_komunikat` (Max-Age 60, closed list of values).
  - No new dependencies, tables or migrations. 1658 tests (PR-06A: 1526).
  - Reviews: C&S PASS (M-1 deadlock reproduced as 40P01 → 500; M-2 `/dopasowania` blocked other
    requests ~5 s; L-1 missing csrf → 400; L-2 kept session not re-checked; L-3 digest tokens after
    an address change) → fix round → C&S PASS (live probe: no 40P01; L-a 200-offer chunk ~0.4 s) →
    time-budget yield → C&S PASS (stall 690 → ≤ 73 ms) → Quality REJECT (counties hint: a county
    alone empties the list silently; bare „powiat” accepted) → copy round → C&S PASS → Quality
    ACCEPT (should-fix: counties note by voivodeship selection) → final copy round → C&S PASS.
  - Owner review of 84adc33 (PR #11): PASS, no blockers; tested in real Chromium (Playwright) with
    500 real BZP offers. Accepted: e-mail change without verifying the new address, the
    duplicate-address message, very old browsers without `Origin`/`Sec-Fetch-Site`. QoL asks done
    in the owner round above. Owner-round reviews: C&S PASS (L-1 a closed client got the free slot
    → fixed; L-2 one session can fill the queue → PR-07; L-3 `CARD_LABELS` tied to digest label
    strings → follow-up) → C&S PASS → Quality ACCEPT (live: 2 parallel requests both 200 in
    0.54/0.91 s; heavy 5.8 s computation → waiters 503 after ~3.07 s, the 9th at once; Medium:
    location hidden in `<details>`, old-address deviation not documented) → fix → C&S PASS →
    Quality ACCEPT. The PR-06A assertion `/profil` `not.toContain(EMAIL)` was replaced (owner
    requirement) by a stricter one: the address appears exactly once, inside the address line.
  - Owner decisions open: last write wins; `/dopasowania` shows already e-mailed offers; one
    `/dopasowania` slot per process shared by all customers (now with a bounded wait queue).

- **PR-07A — Gotowość operacyjna (repozytorium)** (MERGED in PR #12, b622851). D-028 new. Reviews: C&S PASS WITH NOTES (M1 PG* variables,
  L1–L5) → fix round → C&S PASS → Quality ACCEPT WITH NOTES (alert-path proof and softened
  „no alert” sentence, 429 text after a refresh, UTC label in the alert, backup manual until
  PR-07B, consistent control-character messages) → copy round → C&S PASS → Quality ACCEPT.
  Working-tree fingerprint unchanged across every reviewer run.

Owner review (PR #12, PASS, no blockers; QoL notes) → owner-review round: CI `push` only on the
default branch (`ccr-919f3e62-g6j3w9`, commented) + `pull_request` (one run per same-repo PR);
`pnpm audit --prod` step after install (dev-only advisories stay with the full `pnpm audit` in
C&S, SECURITY §13); RUNBOOK „Znane ograniczenie — brak dead man's switch”: silence ≠ OK, real
alert-failure codes (`smtp_535`, `smtp_econnrefused`), daily manual check until PR-07B
(`grep '"checkedAt"'` in `status.log`, `grep '"digestDate"'` in `digest.log`); PR_PLAN PR-07B
gains the external heartbeat (or second mail channel) and a backup-age check in `status`
(owner's 4th note, deferred there); D-028 updated. C&S PASS WITH NOTES (wrong example code) →
fix → PASS → Quality ACCEPT WITH NOTES (concrete daily check) → fix → C&S PASS → Quality ACCEPT.

Round-1 fixes:

- M1: `pg` fills what DATABASE_URL omits from PG* variables, the tools (fresh env) would not:
  `backup`/`restore` now refuse a non-empty `PGHOST`, `PGHOSTADDR`, `PGPORT`, `PGUSER`,
  `PGPASSWORD`, `PGDATABASE`, `PGOPTIONS`, `PGSSLMODE`, `PGSSLNEGOTIATION`
  (`unsupported_database_url`, variable name only), before reading the database; docs say all
  connection settings must be in DATABASE_URL.
- L1/L2/L5 RUNBOOK: restore only our own backups (dump SQL runs as the application role);
  backup directory on a local filesystem with hard links (else `write_failed`); a failed day is
  listed only while its run is < 36 h old, ongoing failures stay `source_failed`/`source_stale`.
- L3: the profile-cli trim test asserts exit 0 and the stored trimmed name.
- L4: an unexpected `status` error with `--notify` sends a fixed alert `status_internal_error`
  (no error text) and still exits 1 with the internal message, also when the alert fails.

- CI (`.github/workflows/ci.yml`): `pnpm check` on push/PR with a PostgreSQL 16 service,
  `REQUIRE_DB_TESTS=1`, actions pinned to full commit SHAs verified with `git ls-remote`
  (checkout v7.0.1, pnpm/action-setup v6.1.0 — peeled commit of the annotated tag, setup-node
  v7.1.0), `permissions: contents: read`, `persist-credentials: false`,
  `--frozen-lockfile`, `postgresql-client` with a ≥ 16 version check. First GitHub run on
  7cd741b green (push and pull_request).
- `status [--notify]` (`src/operations/status.ts`, `status-repository.ts`): per enabled source
  last run / last success / unresolved failed days (36 h), pending (unless a digest holds its
  lock, read from `pg_locks`) and failed deliveries since yesterday (Warsaw); also
  `schema_not_ready` and `database_unavailable`. Exit 0/1. `--notify` sends one plain-text
  alert (ids, codes, timestamps, counts; no `List-Unsubscribe`) to the new `OPERATOR_EMAIL`
  over `EMAIL_MODE`, on every run while a problem lasts; an unexpected error of `status` is
  alerted as `status_internal_error` (no error text) before exiting 1.
- `backup <dir>` / `restore <file>` (`src/operations/backup.ts`, `maintenance-repository.ts`):
  `pg_dump`/`pg_restore` ≥ 16 as children without a shell, password only in the child's
  `PGPASSWORD`, fresh env, refusal (`unsupported_database_url`, variable name only) when a PG* connection
  variable (PGHOST … PGSSLNEGOTIATION) is set, TLS never weaker than `pg`, custom format of the
  current schema, `0600` temp file + `link` (never replaces), restore only into an empty schema
  in one transaction. Restore tested end to end (`tests/integration/backup-restore.test.ts`,
  separate Vitest project run last; fails in CI when the tools are missing).
- Hardening: `/dopasowania` ≤ 2 requests per session (by session id) → 429; HSTS
  `max-age=31536000` for an https `PUBLIC_BASE_URL` only; `\p{Cc}` refused at input (form and
  `profile:create`), stored-row schemas unchanged.
- Docs: `docs/RUNBOOK.md` (new, Polish; „Alert statusu”, sources, deliveries, reply-to mailbox,
  `access:revoke`, backup/restore drill, proxy logs), README (commands, cron `status --notify`
  after ingest and digest, `OPERATOR_EMAIL`, backup), ARCHITECTURE (§2, §4.6, §6 incl. the
  timeout/retry table, §7), SECURITY (§1, §10, §11, §12, §14), `.env.example`.
- One existing test changed deliberately: `profile:create` „names at most five short keywords,
  cleaned” fed an ESC sequence through the CLI, which now refuses control characters; the CLI
  part uses plain keywords and the ESC-cleaning assertion calls `profileWarnings` directly
  (same expected text). The 503 queue test sends its third request from a second session (the
  same session now gets 429 first); its assertions are unchanged.
- No new dependencies, tables or migrations.

- **PR-07B — Wdrożenie na VPS (repozytorium)** (`docs/PR_PLAN.md` → PR-07B) — MERGED in PR #13
  (e01aa0b). D-029 new. Owner decisions (2026-11-03): systemd + cron, PostgreSQL
  16 on the same VPS, Caddy, heartbeat URL from env; the VPS has direct outbound HTTPS (D-014
  unchanged, no proxy support needed).

  - `status` checks backups (`BACKUP_DIR`, absolute path): newest `radar-*.dump` older than 26 h →
    `backup_stale`, none → `backup_missing`, unreadable directory → `backup_dir_unreadable`; JSON
    gains `backup`, the alert a „Kopia zapasowa: …” line. Sources keep the 36 h window. One failed
    backup night is caught by the 07:45 `status` the same morning (26 h 15 min; spring-DST note in
    the code and D-029).
  - Heartbeat (`src/operations/heartbeat.ts`, `HEARTBEAT_URL`, https only, no userinfo/fragment):
    one GET after `status` exits 0, `node:https` with `agent: false`, 10 s, no redirects, no body,
    no retry; JSON `heartbeat` = `disabled`/`skipped`/`sent`/`failed` with fixed reason codes
    (`timeout`, `http_<status>`, `network_<errno>`); the URL is never logged. Covers the cron
    commands, not `serve` (DEPLOY recommends an external uptime check).
  - `deploy/`: `systemd/radar-serve.service` (hardened, `IPAddressAllow=localhost`),
    `cron/radar` (cron.d, host TZ Europe/Warsaw: backup 05:30, ingest 06:00, status 06:30,
    digest 07:30, status 07:45; 14 dumps kept), `caddy/Caddyfile` (access and default logs redact
    `/dostep/…` and `/wypis/…` in the URI and Referer; `log_skip` for those paths; HSTS left to the
    app), `logrotate/radar`, `radar.env.example`, `smoke.sh` (PASS/FAIL only).
  - Docs: `docs/DEPLOY.md` (new, Polish: first deploy, first data incl. AC1, Caddy redaction check,
    heartbeat, encrypted off-host copy with append-only `rrsync`, §13 checklist with restore,
    alert-path and source-error drills, updates); RUNBOOK, README (cron moved to
    `deploy/cron/radar`), `.env.example`, SECURITY, ARCHITECTURE, D-029.
  - Tests: `tests/status-config.test.ts`, `tests/heartbeat.test.ts` (local TLS server; skipped only
    without openssl and never in CI), `tests/deploy-artifacts.test.ts`; status/backup/CLI and
    integration tests extended (cron schedule vs. 26 h window, DST). No new dependencies, tables
    or migrations.
  - Reviews: C&S PASS WITH NOTES (M1 36 h window missed one failed night → 26 h; M2 Caddy's error
    log could record tokens → filter in both logs + DEPLOY §8 check; L1–L4) → fix round → C&S
    (L5 wrong spring-DST wording) → fix → C&S PASS → Quality (H1/H2 checklist and first-data gaps,
    M1–M4 docs) → fix round → C&S PASS (round 4) → Quality ACCEPT (round 2) → docs polish of the
    optional Lows → C&S PASS. One existing test changed deliberately: the env-example test expects
    `heartbeatUrl: null` (the example ships `HEARTBEAT_URL=` empty) and gained an assertion that a
    filled-in https URL is accepted (C&S: justified).
  - Owner review of 4d85cab (PR #13): PASS, no blockers (`systemd-analyze security` exposure 1.4
    „OK”, cron, smoke, heartbeat and backup check verified; Caddyfile not validated locally). QoL
    asks → owner-review round:
    - `GET`/`HEAD /zdrowie` in `serve` (`src/web/server.ts`): `select 1` through the existing pool,
      one shared in-flight probe (a flood holds at most one connection), each request waits ≤ 2 s
      → 503; a hung probe stays shared until the pool ends it (~40 s: 5 s acquire + 35 s
      `query_timeout`); 200 `ok` / 503 `niedostępne`, `text/plain`, `no-store`, same security
      headers, 405 + `Allow: GET, HEAD` for other methods, fixed log code `health_check_failed`.
      `deploy/smoke.sh` and the external uptime check (DEPLOY §10) target it, so a sandbox or DB
      failure of `serve` is no longer silent.
    - Off-host copy: weekly check on the backup server that the newest file is < 48 h, what to do
      on `BRAK`, optional second heartbeat from the backup user's crontab (URL in a 0600 file read
      with `curl -K`, never in cron lines, argv or logs). RUNBOOK: `/zdrowie` 503 triage.
    - Proxy rate limiting stays out of PR-07B (Next action).
    - Reviews: C&S PASS (round 6; L-1 an existing test's sleeps 50 → 300 ms against flakiness,
      assertions unchanged; L-2 ~40 s wording; L-3 SECURITY line → added, C&S PASS 6b) → Quality
      ACCEPT (round 3; Lows: next step on `BRAK`, GET with keyword vs. status only, `health` JSON
      wording) → copy round → C&S PASS. 1904 tests (+10).
  - Not verifiable in the container (owner, on the VPS): `caddy validate` and the redaction check,
    systemd/cron install, smoke test, restore/alert/source-error drills, AC1.

## In progress

**PR-10 — Wejście bez pułapek** (`docs/PR_PLAN.md` → PR-10) — READY locally: Code & Safety
Review PASS (re-checked after every fix round; the last round without findings), Quality
Review ACCEPT (all 6 ACs met). D-031 new; D-026 and D-027 changed. Migration
`0008_self_service_access`.

- „Wyślij mi link” (`POST /wyslij-link`, form on `/` and on the invalid-link page): login-CSRF
  like `/dostep`, body ≤ 1 KiB, the same 200 page for every valid address (existing, unknown,
  inactive, limit reached). Lookup, limit and sending run after the response in an in-memory
  queue of `serve` (`src/web/mail-queue.ts`: 1 running, ≤ 20 waiting, overflow
  `access_mail_queue_full`; on shutdown waiting jobs drop and the running one gets ≤ 5 s). One
  send attempt, no retry. The link is a login token (one use, 7 days, D-026), also for
  `active = false`; only the current address is looked up, never `pending_email`.
- Limits: ≤ 3 e-mails per profile and kind in 24 h, counted in `access_emails` (profile, kind,
  time; never the address or a token) under the profile row lock (`FOR NO KEY UPDATE`, D-027
  lock order), written before sending; ≤ 10 requests per IP per hour in memory (≤ 10 000 keys,
  IPv6 by /64; the IP from the last `X-Forwarded-For` entry only behind the loopback Caddy) →
  429 page.
- E-mail change with confirmation: the `email_confirm` field is gone; the new address goes to
  `pending_email` while digest, links and login stay on the old one. The old address gets a
  notice without links and without the new address (sent first; the confirmation follows even
  when the notice fails), the new one `/potwierdz-email/<token>` (purpose `email_change`, one
  use, 24 h, bound to the address). `GET` changes nothing; `POST` swaps the address in one
  transaction with `revokeOtherAccess`. Of two parallel confirmations one wins, the other gets
  the invalid-link page; an address taken at confirmation gets a neutral message and no
  change; the form no longer reports a taken address (no oracle). „Anuluj zmianę” (POST + CSRF)
  clears `pending_email` and the token.
- Home page `/` (what it is, sources BZP + BK, how to start, the form, `/przyklad`, contact);
  `/przyklad` renders a pseudonymised sample with the `/dopasowania` view, without the
  database; optional `CONTACT_EMAIL` (validated at start; shown on the home, 409 and 429 pages
  and in the old-address notice; never logged). `GET /dostep/<token>` says the link works once.
- Deploy: `radar-serve.service` writes only to the outbox (`ReadWritePaths=-…`) and reaches
  only the loopback with `EMAIL_MODE=test`; the drop-in
  `deploy/systemd/radar-serve.service.d/smtp.conf` resets `IPAddressDeny` for `smtp`. Caddy
  redacts `/potwierdz-email/` in access logs like `/dostep/` and `/wypis/`. RUNBOOK („klient
  nie dostaje linku”, limits, `CONTACT_EMAIL`), SECURITY, DEPLOY, ARCHITECTURE, README and
  PRODUCT (promise = BZP + BK) updated.
- Changed tracked assertions (contract change of scope item 3, D-027 → D-031): the
  `email_confirm`/„Powtórz adres e-mail” cases in `tests/web-profile-form.test.ts`,
  `tests/web-pages.test.ts` (field count 6 → 5) and `tests/integration/web-profile.test.ts`
  (the taken-address field error and the immediate-change revocation test became pending
  address and confirmation tests); `NOTICES` in `tests/web-session.test.ts` gains the new
  notices; `tests/deploy-artifacts.test.ts` (the serve unit has `ReadWritePaths` for the
  outbox; Caddy `@token` and the log redaction include `/potwierdz-email/`); the migration
  lists gain `0008_self_service_access`. 2094 tests in 61 files (+76).
- Deferred: Quality NIT 1 — `/przyklad` dates are fixed (already in the past); make them
  relative to the render time with an injectable clock (`docs/PR_PLAN.md` → PR-11). Optional
  C&S notes: the test helpers wait 5 s, as long as the Vitest timeout; in RUNBOOK the
  `login_link` database step can still log `failed`/`no_profile`/`limit_reached` after
  `dropped`; `deploy/radar.env.example` could say „when an address change is requested”.

**PR-09 — Kalibracja dopasowań i narzędzia operatora** (`docs/PR_PLAN.md` → PR-09) —
PR READY: Code & Safety Review PASS (round 3), Quality Review ACCEPT (round 2); awaiting owner
review. D-023, D-024, D-028 updated.

- Scoring (D-023): a keyword gives +30 when a counted keyword's assigned hit is in the title,
  +15 (`POINTS.keywordInDescription`) when all are in the description; threshold 50 and other
  points unchanged. Keyword-only in the description + region = 35 (no match; pilot cases
  tractor/excavator via „oświetlenie”/„elektryczne” pinned in `tests/matching.test.ts`),
  title keyword + region 50 and category + region 60 match as before, category + description
  keyword with unknown region 55. `profile:create` prints a „Wskazówka” line (keywords without
  exclude keywords); `match:preview` appends „w tym N bez słowa kluczowego (tylko kategoria i
  region)” when N > 0. Changed tracked assertion: the `POINTS` `toEqual` (new key).
- Operator commands (D-024): `deliveries:pending` (JSON groups per profile, transport, day:
  ids, dates, counts; ≤ 1000 groups, `truncated`) and
  `deliveries:resolve <profileId> --sent|--failed [--date]` (one transaction,
  `pg_try_advisory_xact_lock(DIGEST_LOCK_KEY)`, only `pending` rows of the profile/day;
  `--sent` → `sent`, `--failed` → delete). Refusal exit 1 while a digest (or another
  `deliveries:resolve`) holds the lock or when no row matches. Both/neither switch, bad
  uuid/date → exit 2 (usage, before the database is opened). README „Wynik niepewny” and
  RUNBOOK use the commands instead of SQL.
- Labels and footer: `CATEGORY_LABELS` moved to `src/domain/vocabulary.ts`; the digest
  (category line and reasons) and `/dopasowania` show labels, never keys; `match:preview`
  keeps keys with their CPV codes. Since the Quality fix round: the reason shows labels only,
  each in „…”, joined with „, ” and without codes („kategoria: „Elektryka”, „Serwis, naprawy i
  konserwacja””; „; ” only between reasons); the „Kategoria:” line joins labels with „; ”
  (labels contain commas) and then „ · CPV: ” with the codes („CPV: …” alone without an MVP
  category). Digest footer says what the profile page offers. Changed tracked assertions:
  `tests/digest.test.ts` (the „Kategoria”/„Dlaczego pasuje” lines of the first test and the
  CPV-only line: `CPV ` → `CPV: `) and `tests/integration/web-profile.test.ts` (the reason).
- `status` (D-028): new problem `source_incomplete` when the two newest non-failed runs of
  a source (two different publication days, newest run per day) are both `incomplete`; a single
  one does not alarm. The report and the `--notify` alert list day, `runId`, start and
  `part: reason`. `evaluateStatus` takes `completedRuns` (test fixture helpers gained the
  parameter). RUNBOOK „Alert statusu” row. Catch-up (D-021) unchanged.
- Tests: `tests/deliveries-cli.test.ts` (new), DB tests for pending/resolve (lock held,
  only target rows, end-to-end resend after `--failed`, no resend after `--sent`) and for
  `source_incomplete` with the alert. 2014 tests (+53).
- C&S Review PASS → fix round (low findings and nits): lock refusal names „a digest run or
  another deliveries:resolve” (result `lock_busy`), RUNBOOK: not at the digest cron minute
  (7:30); DB test of the `truncated` boundary (1001 → 1000 + `truncated`, exactly 1000 → not);
  `CATEGORY_LABELS` imported from the domain (re-export in `profile-form.ts` dropped; the
  import in `tests/web-profile-form.test.ts` moved, assertions unchanged); labels joined with
  „; ”; stale exit-code remark removed; Next action updated. 2017 tests (+3).
- Quality Review CHANGES REQUESTED → fix round (with C&S nits N1, N2): the `profile:create`
  hint gives narrow excludes („ciągnik”, „koparka”, „dostawa paliwa”) and says exclusion also
  applies to the description (the broad „pojazd”/„dostawa” would drop an electrician's own
  tenders); README and D-023 state that offers without CPV need a title keyword; category
  wording in „Dlaczego pasuje” and on the „Kategoria:” line (above; `CATEGORY_SEPARATOR`
  removed); footer „Na stronie profilu możesz zmienić kategorie, regiony i słowa kluczowe oraz
  zobaczyć wszystkie pasujące zamówienia.”; README/RUNBOOK uncertain-delivery procedure: the
  recipient address from `profile:show` (field `email`, not to be pasted into tickets or
  logs) and `--sent` as the default when the outcome cannot be established; the lock refusal
  names „another deliveries:resolve” in README, the usage text and the doc comment. New test:
  the „Kategoria:” line with labels and more than five codes. 2018 tests (+1).
- C&S round 3 PASS (nits only) → Quality round 2 ACCEPT: `docs/PRODUCT.md` example of
  „dlaczego pasuje” aligned with the labelled wording; the singular „kategoria:” prefix stays
  (a reason-type tag like „słowo:”/„region:”; revisit together with the „Kategoria:” field
  label only if pilot customers ask). Watch in the pilot: a profile with many categories that
  all hit one CPV-rich offer gets a long reason (~200 characters).
- Owner review of PR #15 (PASS, one Medium + two QoL) → fix round: (1) D-023 genitive plural:
  a keyword token of ≥ 6 characters ending in „nie”/„cie” also matches a text word equal to it
  without „ie” („szkolenie” → „szkoleń”, „oświetlenie” → „oświetleń”, „sprzątanie” →
  „sprzątań”, „zajęcie” → „zajęć”), equality only, never a prefix („malowane”,
  „zarządzanego” do not match); `KeywordToken.genitivePlural` in `src/matching/text.ts`, no
  stemmer; known limit: only from the „-nie”/„-cie” form itself („szkolenia” ≠ „szkoleń”).
  No existing matching expectation changed.
  (2) `deliveries:resolve … [--transport test|smtp]`: only rows of that transport change
  (`transport` filter on both the UPDATE and the DELETE); default the current `EMAIL_MODE`'s
  transport via `loadEmailMode` (EMAIL_MODE alone, same schema, no SMTP secrets; invalid →
  exit 1 before the database); with `--transport` EMAIL_MODE is not read;
  repeated/missing/other value → exit 2; the JSON output adds `transport`;
  `deliveries:pending` already listed it. Changed tracked assertions (stricter, forced by the
  new field): the resolve request/stdout `toEqual`s in `tests/deliveries-cli.test.ts` and the
  `--sent --date` stdout `toEqual` in `tests/integration/digest.test.ts` gained
  `transport: "test"`.
  (3) RUNBOOK step 3: after
  `--failed` an offer returns only in a later digest over the same transport that still finds
  it a candidate (not `closed`/`cancelled`, deadline not passed, first stored ≤ 7 days before
  the run, matches the profile as it is then, within 50 per e-mail / 10 000 candidates; one
  e-mail a day). README, D-023, D-024, ARCHITECTURE, PR_PLAN updated. 2053 tests (+35).
  Code & Safety Review of the round: PASS with four Lows, fixed: (L1) when `deliveries:resolve`
  changes 0 rows the message names the transport („…has no pending deliveries over transport
  "test"; nothing was changed.”, with `--date` „…of that day over transport "test"…”) — the
  old „the profile has no pending deliveries” was false while rows of the other transport
  were pending (e.g. after `EMAIL_MODE` changed test → smtp). Changed tracked assertions
  (stricter, forced by the new text): the two exact messages of „exits 1 when no pending row
  matches” in `tests/deliveries-cli.test.ts`, and the `--date` case in
  `tests/integration/digest.test.ts` („exits 1 and changes nothing…”), from
  `toContain("no pending deliveries of that day")` to the exact message (`toBe`). (L2) D-023
  and `src/matching/text.ts`: known limit — for „-ycie”/„-icie” nouns the genitive plural
  equals the infinitive („pokrycie” → „pokryć koszty”, „zużycie” → „zużyć”, „użycie” →
  „użyć”; narrow, related meaning, accepted; generalised in the doc-only round below). (L3) README `profile:create` row
  mentions the genitive plural. (L4) comments: `digestDate` null = every pending row of the
  profile and transport (`ResolveRequest`, `ResolveArgs`); which commands read the e-mail
  variables (`runCli`, `loadEmailConfig`). Tests added: exclude „szkolenie” removes
  „Organizacja szkoleń”; the „-ycie” over-match documented; resolve with `--transport smtp`
  and 0 rows names „smtp”; `EMAIL_MODE=smtp` with a malformed `SMTP_URL` holding a password
  resolves over smtp and prints neither the URL nor the password. 2057 tests (+4).
  Quality Review of the round ACCEPT → doc-only round (no code or test change): (L-a) D-023
  and the `src/matching/text.ts` comment generalise the known limit to „-cie” nouns whose
  infinitive has the same form („-ycie”, „-icie”, „-ucie”, „-ście”: pokrycie/pokryć,
  zatrucie/zatruć, przejście/przejść, szycie/szyć) — accepted for include keywords, a silent
  missing alert for exclude keywords („przejście” vs „przejść weryfikację”), so such excludes
  with care; (L-b) README: the e-mail variables are read by `digest` and `status --notify`;
  tips: README `profile:create` — type the singular „-nie”/„-cie” form („szkolenie”, not
  „szkolenia”); RUNBOOK step 3 — after `--failed` the offer returns in the next `digest`
  (the nearest 7:30 cron — tomorrow's when resolved after today's run), earlier only via a
  manual `digest` with no other `sent`/`pending` row of that profile and transport today;
  Code & Safety re-check PASS, its Low L1 („czyli jutro” too narrow when resolving between
  the 06:30 alert and the 7:30 cron) folded in by the coordinator (wording only).
- CI fix (owner-approved addition to PR-09): the `ubuntu-latest` runner image moved to 26.04,
  where `postgresql-client` gives client 18; pg_dump ≥ 17 writes `SET transaction_timeout`,
  which the `postgres:16` service rejects, so the backup/restore test failed. `ci.yml` now
  adds the PGDG repository (the runner has none; `apt.postgresql.org.sh -y` from
  `postgresql-common`), installs `postgresql-client-16`, puts `/usr/lib/postgresql/16/bin` on `PATH` and requires
  major 16; D-028 CI sentence updated. No code or test change.

**PR-08 — Drugie źródło: Baza Konkurencyjności (adapter `bk`)** (`docs/PR_PLAN.md` → PR-08) —
**MERGED in PR #14 (366618e)**; D-030 new.

- `src/sources/bk/adapter.ts`: day listing (`/api/announcements/search`, current-version
  publication date, one page of 250; two sort orders only over 250 — see the owner-review
  bullet below; `max_records`) plus one detail per announcement, at most 250 per day.
  `externalId` = announcement id, `sourceUrl` = `/ogloszenia/{id}`; value only as the sum of all
  orders' values (else `null`), `PLN` only with a value, voivodeship only when shared by all
  places, contact e-mail/phone only.
- Fix round after Code & Safety Review (PASS, 2 M + 3 L + 1 Nit): a detail answered 404
  (`detail_missing`) or outside the detail envelope (`detail_invalid`) is skipped and reported in
  `incomplete`, at most 2 per day; the third, or a day with no readable detail, fails the day.
  A page shorter than requested before the listing's end, and a listing record of another
  publication day, are `invalid_document`. Source order documented (`bk` before `bzp`, worst
  case for BZP's start). `BK_SOURCE_ID` and the attribution text are in
  `src/sources/bk/attribution.ts`.
- Fix round 2 after Quality Review (H1, M2, L1, L2 + D-030 notes): fetch checks each detail
  with the same `extract` (envelope + `bkRecordSchema`), so a renamed required field (`title`,
  advertiser name) is `detail_invalid` and, past the limit, `invalid_document`; a day of
  more than 2 read records that `normalize` all rejects is `invalid_document` too (`status`
  alerts; C&S round 3 M-R3-1: 1–2 such records are only counted, so a small day does not fail
  every morning). DEPLOY §6:
  preview checks `rejected`, backfill by ~22:00 with the JSON summary review, reruns by
  `--date`/`--from`, `digest --dry-run` before the first post-backfill digest. D-030 lists the
  silent-null limit of optional fields, multi-region offers (`region_unknown`) and the
  net/gross label.
- Migration `0007_bk_source` seeds `bk` **disabled**; enabling, AC1 and backfill in
  `docs/DEPLOY.md` §6 „Drugie źródło: Baza Konkurencyjności”. Ingest source timeout 10 → 15 min per day (preview stays 5 min).
- Attribution „Źródło” in the digest and on `/dopasowania` for `bk` offers.
- AC1 (real preview outside the container) is the owner's step.
- Reviews: C&S PASS (round 1: M-1 one bad detail failed the day, M-2 short page, L-1–L-3, Nit) →
  fix round → Quality CHANGES REQUESTED (H1 silent zero on a renamed required field, M1 STATE,
  M2/L2 backfill checks, L1 README, L3 `docs/LAUNCH_ROADMAP.md`) → fix round 2 → C&S PASS
  (round 3; M-R3-1 small all-rejected day failed every morning → threshold > 2, L-R3-1 RUNBOOK
  BZP delay) → fix → C&S PASS (round 4) → Quality ACCEPT (round 2). Tracked tests changed only
  by list additions (new source id, migration, incomplete reasons). 1958 tests (+54).
- Owner-review round (PR #14): the owner measured 2026-11-04 (total 130) that pages of 100 gave
  111 distinct ids in both orders and in their union, while one page of 200/500 gave all 130.
  The listing is now one page of 250 (`BK_PAGE_SIZE` = `BK_MAX_DETAILS_PER_DAY`, ~180 KB, within
  the 5 MiB response limit) whatever `--limit`, so a day of up to 250 is one request (also in
  preview). Over 250: the two-order pagination as fallback, 2 pages per order. A listing with
  fewer distinct ids than its target now **fails the day** (`invalid_document`, "listing
  has fewer distinct records than its total", log `source listing short`) before any detail:
  `status` alerts and catch-up retries it (D-021). `listing_mismatch` removed from
  `incompleteReasons` (added in this PR, not stored by any released version); bk no longer
  reports `max_pages` (supersedes the listing reasons in the first bullet). Also C&S L-R4-1
  („Koszt” wording), L-R4-2 (skips + all-rejected unit case) and the DEPLOY
  `jq '{status, notRun}'` check.
- C&S round 5: the target is the whole total for a one-page listing (≤ 250), whatever the
  budget, so a small-`--limit` preview checks it too (no extra request); min(total, budget)
  only over 250 (M-R5-1). RUNBOOK: re-run a day with a stored `listing_mismatch` (L-R5-2).
- C&S round 6 PASS → Quality ACCEPT (round 3). Coordinator: RUNBOOK keeps `bk` on when only one
  old day repeats (Quality L1); D-030 cost of failing the whole day (N1); DEPLOY step 3 wording
  (N3); PR_PLAN listing scope; `docs/LAUNCH_ROADMAP.md` risk row without `listing_mismatch`
  (C&S L-R5-1) and RODO art. 14 (owner's review) as stage 3c item and owner decision 6.
  1961 tests (+3 over the PR head 442b581).
- `docs/LAUNCH_ROADMAP.md` (new): stages from PR-08 to the market test; linked from ROADMAP.

## Blockers

- **PR-08 AC1 (real `bk` records via `source:preview bk`)** cannot be verified in the container
  (proxy-only egress, D-014). Owner, on the VPS after the merge (`docs/DEPLOY.md` §6 „Drugie
  źródło: Baza Konkurencyjności”, checklist item 18): `source:preview bk` for a past weekday
  (check `normalized`, `rejected` and its reasons, `incomplete`, 2–3 `sourceUrl` against the
  page), decide, enable `bk`, 30-day backfill by ~22:00 with the JSON summary check, `digest
--dry-run` before 7:30, `status` the next morning. Record "PR-08 AC1 verified by owner" with
  the counts.
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

- (Answered 2026-11-03: the production VPS has direct outbound HTTPS, so SafeHttpClient runs
  there unchanged and D-014 needs no proxy support. AC1 is now run on the VPS during the first
  deploy, `docs/DEPLOY.md` §6 „Pierwsze dane”.)

## Decisions made

See `docs/DECISIONS.md` (D-001 … D-030). D-007 and D-009 accepted in PR-01; D-014 (HTTP client
on `node:https` with pinned lookup, no HTTP library) accepted in PR-02 Part A; D-015 (first
source: BZP through the official API) in PR-02 Part B; PR-03 Part A: D-016 (fingerprint and
`content_hash` format), D-017 (`unchanged` writes nothing, no `last_seen_at`), D-018 (ingest
limit 1000 per notice type, 10-min source timeout, streaming), D-019 (advisory lock), D-020
(source selection and configuration errors). The PR-03A owner-review round amended D-015
(notice-update limitation, `tenderId` mapping), D-016 (`tenderId` in `content_hash`), D-019
(lock busy → skipped, exit 0) and D-020 (readiness = no pending migrations) without new IDs.
PR-03 Part B: D-015 amended (notice updates: linking by `tenderId` only, older-row rule,
latest published update wins, provenance columns, skip reasons), D-019 (busy report shape),
D-021 (ingest day ranges and automatic catch-up). PR-03 Part C: D-022 (offer details from
`htmlBody`, normalization helpers, CPV → MVP dictionary); D-015/D-016 amended (offers read
`htmlBody`; `content_hash` consequence of the new values). PR-04: D-023 (matching rules,
region semantics, profile schema, `match:preview`). PR-05: D-010 accepted (SMTP via
nodemailer), D-024 (digest, `deliveries`, failure classes, `pending` procedure). PR-06A: D-025
(web server on `node:http`), D-026 (e-mail tokens, session, CSRF, one-click unsubscribe);
D-024 amended (footer links, `List-Unsubscribe` https + mailto). PR-06B: D-027 (customer
screens, e-mail change, matches list, login-CSRF); D-025 amended (`strict-origin`). PR-07A:
D-028 (`status` rules and operator alert, backup/restore, per-session `/dopasowania` cap, HSTS,
control characters at input, CI). PR-07B: D-029 (VPS deployment: systemd + cron, Caddy with
token redaction, backup-age check in `status`, heartbeat). PR-08: D-030 (second source: Baza
Konkurencyjności — listing and detail limits, skip limit, all-rejected guard, mapping,
attribution, source order); D-018 and D-021 notes (15-min source timeout, `bk` catch-up).

## Next action

0. PR-10: READY (Code & Safety Review PASS, Quality Review ACCEPT), base branch merged in
   after PR #15 → owner review of its PR (not merged by the agents). Then PR-11 – PR-13 in
   order (`docs/PR_PLAN.md`). Each PR opens only when ready for owner review.
1. PR-09: MERGED in PR #15 (42dd008). On the VPS
   (PR-08 is merged, 366618e): PR-07B checklist (`docs/DEPLOY.md` §13) if not done yet, then
   PR-08 AC1 and the `bk` backfill (Blockers). Follow-ups from the PR-08 reviews (owner to
   choose the PR):
   - Backup client version (found by the PR-09 CI fix, later PR): README/D-028/RUNBOOK
     „klient ≥ 16 / nie starszy niż serwer” and the version check in
     `src/operations/backup.ts` are too permissive — a newer client (17+) makes a dump that a
     16 server cannot restore (`SET transaction_timeout`); require the server's major or
     document the restore-side limit.
   - Calibration aid (Quality Review of PR-09, out of scope): a `match:preview` counter of
     near misses — offers dropped only because the keyword was in the description (they would
     match with a title keyword) — for calibrating pilot profiles.
   - (Done in PR-09: `status` reports `source_incomplete` when the two newest days of a
     source are both `incomplete` — C&S L-R2-1. A single day's detail skips
     (`detail_missing`/`detail_invalid`) are still visible only in the ingest summary/log.)
   - Partial value (owner's review, QoL): when only some orders of a `bk` offer have a value,
     the value stays `null`; showing „wartość części: …” in the digest needs a separate field
     and a digest text change (D-030 value rule), so it is a separate PR.
   - A day failed by "every record of the day was rejected" is read in full (~9 min) on every
     catch-up morning and delays BZP (RUNBOOK says to disable `bk`); a cheaper early stop or a
     per-day give-up could follow (C&S L-R3-1, Quality).
   - Offers covering several voivodeships are `region_unknown` with a misleading reason text;
     net/gross label of the value; volume of the first digest after the backfill (D-030 notes).
   - Nits: `docs/SECURITY.md` bk line wrapping and a repeated sentence; long attribution line in
     `docs/LAUNCH_ROADMAP.md`.
     Still open from PR-06B: last write wins, already-sent offers on `/dopasowania`, the shared
     `/dopasowania` slot. Still open from PR-06A: TTLs (7/60/30 days; kept by the owner's
     decision of 2026-11-06), §8.3 leniency on `/wypis`, forwarded digests. (Done in PR-10:
     the self-service „Wyślij mi link” form, D-031.)
2. Left after PR-07B (owner to choose the PR): rate limiting at the proxy (incl.
   `/dopasowania` across sessions, PR-06B C&S L-2); `serve` uptime is covered only by the
   external uptime check recommended in DEPLOY §10 (the heartbeat covers the cron commands).
   Follow-ups from the PR-06B reviews (owner to choose the PR):
   - (Done in PR-07A: `\p{Cc}` refused at input — C&S L-c.)
   - (Done in PR-09: match reasons on `/dopasowania` and in the digest show category labels
     from `CATEGORY_LABELS` instead of raw keys.)
   - (Done in PR-09: the digest footer says what the profile page offers („Na stronie profilu
     możesz zmienić kategorie, regiony i słowa kluczowe oraz zobaczyć wszystkie pasujące
     zamówienia.”).)
   - When a source starts providing counties, update the counties hint/note (`src/web/pages.ts`)
     and D-023/D-027.
   - Re-measure `/dopasowania` on pilot data (C&S measured 8.5–9 s for 5 000 candidates with 3.2 KB descriptions).
   - (Done in PR-10: the old address gets a notice when a change is requested, and the change
     waits for a confirmation from the new address, D-031.)
   - Build `CARD_LABELS` (`src/web/pages.ts`) from label constants exported by the digest
     (C&S L-3; today a renamed digest label would move that field into `<details>`).
   - Accessibility nits (Quality Low): the repeated „Szczegóły ogłoszenia” summary label could
     name the offer; find-in-page does not search closed `<details>` in some browsers.
     Pilot follow-ups from the owner's PR #9 review (owner to choose the PR):
   - (Done in PR-09: a description-only keyword hit gives +15 and `profile:create` hints at
     exclude words, D-023; further calibration on pilot profiles if real runs still show false
     positives.)
   - (Done in PR-09: operator commands `deliveries:pending` and `deliveries:resolve` replace
     the manual SQL in README „Wynik niepewny”, D-024.)
   - README example of the `List-Unsubscribe` header without ` (Wypisz)` (C&S L-1, cosmetic).
   - Before real customers: confirm `smtp` explicitly (SECURITY §10/§14) and send one digest to an own
     mailbox first. Optional follow-ups from the PR-05 Quality Review: (done in PR-09 for the digest
     and `/dopasowania` — the reason shows labels only; `match:preview` keeps the codes) cap
     the CPV codes repeated in „Dlaczego pasuje”; Polish date format („3.11.2026, 11:00”); a different heading for a new
     profile's first e-mail (up to 7 days of offers); the other „CPV spoza słownika … kategoria
     niesprawdzalna” wording. Known limits: the stderr pending count misses profiles reported
     `not_run`; a server that closes with an error reply at the greeting spends attempts (D-024).
     Still from PR-04: backfill still-open offers with `ingest bzp --from … --to …` (≤ 31 days
     per call, README); cosmetic nits from Part B (over-wide `ingest` help lines in
     `src/cli.ts`; two test titles still say "200 000"); watch live runs for `too_large` on update
     pages (`BZP_PAGE_SIZE` 25 kept).
3. Owner verifies PR-02 AC1 outside the container (command and checklist under Blockers); a
   first live `ingest bzp --date <past weekday>` on the same machine is a useful follow-up
   check (exit 0, `inserted` > 0, a second run all `unchanged`; `skipped` > 0 and some
   `updated` from `NoticeUpdateNotice` when originals of that day's updates are stored).
4. PR-06 (Minimal User Interface, `docs/ROADMAP.md`): token unsubscribe link done in PR-06A. Notes carried from the PR-04 reviews (PR-05 status marked):
   - Matching cost: ~10–60 ms per offer × profile pair in the worst case (100 ten-token
     keywords, 10 000-char description); fine for 10–100 profiles × ≤ 1000 offers, measure
     before optimising (D-023).
   - Done in PR-05: the digest filters by deadline vs now (past deadlines out) and skips
     `invalid_stored_row` per row (counted). Matching cost re-measured at ~120 µs per pair on
     typical data; tokenizing once per offer still deferred (measure on pilot data).
   - Owner decisions from the PR-04 review (threshold, counties-only profiles) may change the
     scoring before the digest relies on it.
   - Deferred from the owner's PR #8 review: tokenize each offer once per digest run instead
     of once per pair (measure first); for pilot calibration, a "matched only by CPV" counter
     in `match:preview` (done in PR-09: „bez słowa kluczowego”) (category + unrestricted
     region = 60 matches 8–26 offers per profile
     with no keyword; CPV prefix `4533` is broad) and a stem threshold of 3 for letter-only
     words (needs false-positive calibration, e.g. "sad" → "sadzenie").
   - Optional from the PR-04 Quality Review: a `match:preview --all` mode that also prints
     non-matches with reasons (threshold calibration); a `profile:update` command (stored
     profiles breaking the new schema are fixed by hand today); "prefer single words" hint in
     the profile guidance.
   - Resolved in PR-04 (from the PR-03C reviews): `matching` depends on `sources/normalize`
     by an explicit ESLint allowlist (no new neutral module; vocabulary moved to
     `src/domain`); `comparableText` drops `\p{Cf}` (soft hyphen); the missing-CPV reason exists (worded
     "kategoria: ogłoszenie nie podaje kodu CPV" since PR-05); small contracts (no CPV) match on title + description
     keywords — keyword-only ones need a title keyword plus region match/unrestricted (since
     PR-09 a keyword found only in the description gives 15: 35 with the region, below 50).

   Still deferred from the PR-03C reviews:

   - CPV → MVP dictionary calibration (D-022 calls it a starting point): `remonty` is only
     `454` (misses `45000000`, `4526` roofs/masonry, `45262700` przebudowa); `serwis` = all of
     `50` also catches vehicle/ship/aircraft repair (`501`/`502`); candidates `324` (it),
     `397`/`301` (wyposazenie). Do not map bare `45`/`452`; general construction must be
     matched by title/description keywords.
   - Done in PR-05: the digest shows a ~300-character description snippet cut on a word.
   - Field boundaries (D-022, C&S L-a): a description line numbered ≥ its label (e.g. "4.3)"
     inside 4.2.2) ends the field early — shorter description, never wrong data. Refine to
     boundaries within the same top-level section only if real notices show it.
   - The multi-part `ContractNotice` layout (repeated 4.2.2 per part) is inferred, not
     captured: capture one pseudonymised multi-part notice as a fixture and confirm.
   - `pnpm audit`: 1 moderate, dev-only (GHSA-g3hv-75wg-m249, minimatch < 11.0.1 via eslint;
     patterns come from repo config only). Owner proposal: a separate small PR with
     `pnpm.overrides` `"minimatch": ">=11.0.1"` (verify eslint still works) or an eslint bump —
     not part of PR-03C.
   - D-016 "Konsekwencje" still describes the pre-D-021 cron ("tylko wczorajszy dzień") as a
     historical record; optionally add a pointer to D-021 in a later docs pass.

5. Open points carried from D-015/PR-02 for PR-03: whether the API's publication-day boundary
   is UTC or Polish time (cron at ~06:00 Europe/Warsaw ingests yesterday UTC; overlapping days
   are harmless thanks to dedup) — verify on the first live runs.
6. Open question for PR-03C/PR-05 (Quality Review N6): BZP cancellation notices (a tender
   withdrawn → status `cancelled`) have no plan item yet and are not handled by PR-03B
   (recorded in D-015). Without one the digest may show cancelled tenders as open; decide
   whether to fetch and apply them like `NoticeUpdateNotice` (by `tenderId`). PR-05 records
   the limitation (D-024, README) and the e-mail footer says the procedure may have been
   cancelled; since the digest now reaches customers, decide before the pilot.
7. Open item from the PR-03B reviews (C&S L5, Quality Review): deadline changes of small
   contracts are effectively not applied. Both captured `SmallContractNotice` originals
   (fixture 2026-10-29) have `tenderId` = `null`, and updates are linked only by `tenderId`, so
   no update can reach them whatever section 3.1 says. Verify on live data both questions:
   (a) do small-contract originals ever carry a `tenderId`; (b) how section 3.1 "Nazwa
   zmienianego ogłoszenia" reads in a `NoticeUpdateNotice` that changes a
   `SmallContractNotice` (if it is not exactly "Ogłoszenie o zamówieniu", such changes are
   skipped as `not_contract_notice_change`). Suggested check: `source:preview bzp --date <day>`
   on a few weekdays — `SmallContractNotice` records in the list and `updates[].skipReason`
   (`no_original`/`not_contract_notice_change`) of their updates. Until then the stored
   deadline of a small contract may be outdated (recorded in D-015).
8. Deferred in Part A: fingerprint variant for sources with neither an external id nor a
   stable URL (D-016; with the first such source); `last_seen_at` (D-017; when a feature needs
   it, e.g. detecting withdrawn notices).

Notes from the Part A Code & Safety Review (for the Quality Review and later):

- `status` is part of `content_hash` and BZP derives it from `fetchedAt` (deadline passed →
  `closed`), so re-ingesting a notice after its deadline reports `updated` once. Intended: the
  stored state of the offer changed (D-016, D-017).
- **BZP notice updates (owner's live query, 2026-10-28; D-015):** changes to a published
  notice come as a separate notice type, `NoticeUpdateNotice` (handled since PR-03B; until
  then `ingest` did not fetch it).
  At least 100 that day (`PageSize=100` returned a full page; 331 `ContractNotice` the same
  day); in 96 of 100 the `htmlBody` concerns the offer submission deadline. An update notice
  has its own `noticeNumber` and links to the original only through `tenderId`
  (`ocds-148610-…`, present in 100/100); its `submittingOffersDate` is `null` — the new
  deadline is only in `htmlBody`. All 100 had the suffix `/01`; the risk of a new version of
  the original as `…/02` is not confirmed.
  - **PR-03A AC2** (change detected as `updated`): since PR-03B a BZP deadline change reaches
    the stored row through `NoticeUpdateNotice` and is counted as `updated`.
  - **PR-05 and the stored BZP `deadline` (after PR-03B):** PR-05 may rely on the deadline of
    a `ContractNotice` row being updated by `NoticeUpdateNotice` for the days that were
    ingested in order. It still may not rely on it for: small contracts (`SmallContractNotice`
    — originals without `tenderId`, see Next action item 6); days that were clipped
    (`clipped`) or failed days not recovered within the 31-day window (`notRun` included);
    `no_original` skips after an out-of-order backfill or an automatic retry of a failed day
    (changes of its originals published before the retry) until the following days are
    re-ingested (D-021 operator notes). For those, "skip notices past their deadline" can still
    drop a tender whose deadline was extended.
- **PR-04/05:** the stored `status` stays `open` after the deadline for rows that are never
  re-fetched, so matching and the digest must decide "still open" from `deadline` vs now, not
  from the stored `status`. PR-04: `match:preview` lists past-deadline offers last with
  "(po terminie)"; PR-05 still has to filter them out of the digest.

Notes from Part B (for later PRs):

- PR-03B observability (Quality Review): deadline updates are counted in `updated` together
  with changed notices; skip reasons are counted per run in `runs[].skippedReasons` (owner
  review of PR #6) and logged at info (`notice update skipped`).

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
  - ~~`htmlBody` contains the buyer's contact and sometimes the order value~~ — done in
    PR-03C: offers store description, contact and estimated value + currency from `htmlBody`
    (D-022).
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
  - ~~**PR-03 normalizer:** a published contact e-mail that fails `emailSchema` goes to
    `contact.raw` as published — it must not reject the whole notice~~ — done in PR-03C.
  - **PR-03:** compute the fingerprint and `content_hash` from the validated draft (canonical
    `sourceUrl`), not from raw adapter input.
  - **PR-02:** `base_url` is a stored display link (IP literals / port 0 are accepted by the
    domain schema); never trust it as a fetch target without SafeHttpClient's host/SSRF checks.
  - **PR-04/05:** list/digest reads must handle `invalid_stored_row` per row (skip + log the
    row id), so one inconsistent row does not abort the whole run. Done for
    `listMatchCandidates`/`match:preview` in PR-04 and for the digest in PR-05.
  - **PR-05/06:** stored URLs may still contain `'`, `` ` ``, `{`, `}` and percent-encoded
    controls — escape contextually on output (SECURITY §10).
  - **PR-07 CI:** done in PR-07A (`CI=true`, `REQUIRE_DB_TESTS=1`, `TEST_DATABASE_URL`).
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

2026-11-10, PR-10 after merging the base branch (PR #15, 42dd008) in (Node 22, pnpm 10.28.0,
PostgreSQL 16): `TEST_DATABASE_URL=postgres://radar:radar@localhost:5432/radar_test
REQUIRE_DB_TESTS=1 pnpm check` — format, lint, typecheck clean; 2133 tests passed in 61 files,
none skipped (2094 PR-10 + 39 from the PR-09 owner-review round). Conflicts only in README,
STATE and one `src/cli.ts` config block (both sides kept).

2026-11-09, PR-10 before the PR (Node 22, pnpm 10.28.0, PostgreSQL 16): `TEST_DATABASE_URL=postgres://radar:radar@localhost:5432/radar_test
REQUIRE_DB_TESTS=1 pnpm check` — format, lint, typecheck clean; 2094 tests passed in 61 files,
none skipped (run by the coder, the Code & Safety and Quality reviewers and the coordinator).
No dependency changes; no network requests to live sources; no e-mail sent (tests use the
`test` transport and in-memory senders). Working-tree fingerprint unchanged across every
reviewer run.

2026-11-09, PR-09 owner-review round (Node 22, pnpm 10.28.0, PostgreSQL 16): `TEST_DATABASE_URL=postgres://radar:radar@localhost:5432/radar_test_pr09
REQUIRE_DB_TESTS=1 pnpm check` — format, lint, typecheck clean; 2057 tests passed in 58 files,
none skipped (run by the coder, after the Code & Safety Lows). No dependency changes; no network requests to live sources; no
e-mail sent.

2026-11-06, PR-09 before the PR (Node 22, pnpm 10.28.0, PostgreSQL 16): `TEST_DATABASE_URL=postgres://radar:radar@localhost:5432/radar_test
REQUIRE_DB_TESTS=1 pnpm check` — format, lint, typecheck clean; 2018 tests passed in 58 files,
none skipped (run by the coder, C&S round 3, Quality round 2 and the coordinator). Full
`pnpm audit`: unchanged (1 moderate, dev-only minimatch via eslint). No dependency changes; no
network requests to live sources; no e-mail sent. Working-tree fingerprint unchanged across
every reviewer run.

2026-11-05, PR-08 owner-review round (Node 22, pnpm 10.28.0, PostgreSQL 16): `TEST_DATABASE_URL=postgres://radar:radar@localhost:5432/radar_test
REQUIRE_DB_TESTS=1 pnpm check` — format, lint, typecheck clean; 1961 tests passed in 57 files,
none skipped (run by the coder, C&S round 6, Quality round 3 and the coordinator). No
dependency changes; no network requests to the live source from the container (fixtures only);
no e-mail sent. Working-tree fingerprint unchanged across every reviewer run.

2026-11-05, PR-08 before the PR (Node 22, pnpm 10.28.0, PostgreSQL 16): `TEST_DATABASE_URL=postgres://radar:radar@localhost:5432/radar_test
REQUIRE_DB_TESTS=1 pnpm check` — format, lint, typecheck clean; 1958 tests passed in 57 files,
none skipped (run by the coder, C&S round 4, Quality round 2 and the coordinator). No
dependency changes; no network requests to the live source from the container (fixtures only);
no e-mail sent. Working-tree fingerprint unchanged across every reviewer run.

2026-11-04, PR-07B owner-review round (Node 22, pnpm 10.28.0, PostgreSQL 16): `TEST_DATABASE_URL=postgres://radar:radar@localhost:5432/radar_test
REQUIRE_DB_TESTS=1 pnpm check` — format, lint, typecheck clean; 1904 tests passed in 55 files,
none skipped (run by the coder, C&S round 6 and Quality round 3). Full `pnpm audit`: unchanged
(1 moderate, dev-only minimatch via eslint). No dependency changes; no e-mail sent.
Working-tree fingerprint unchanged across every reviewer run.

2026-11-03, PR-07B before the PR (Node 22, pnpm 10.28.0, PostgreSQL 16, pg_dump/pg_restore 16):
`TEST_DATABASE_URL=postgres://radar:radar@localhost:5432/radar_test REQUIRE_DB_TESTS=1 pnpm check`
— format, lint, typecheck clean; 1894 tests passed in 55 files, none skipped (PR-07A: 1793 in
52); run by the coder, C&S round 5 and the coordinator. Full `pnpm audit`: unchanged (1
moderate, dev-only minimatch via eslint). No dependency changes; no e-mail sent; no network
calls to real heartbeat services (local TLS test server only). Caddy, systemd and cron files
are checked by `tests/deploy-artifacts.test.ts` only; `caddy validate` and the drills run on
the VPS (`docs/DEPLOY.md` §13). Working-tree fingerprint unchanged across every reviewer run.

2026-11-03, PR-07A owner-review round (CI and docs only): `TEST_DATABASE_URL=postgres://radar:radar@localhost:5432/radar_test
REQUIRE_DB_TESTS=1 pnpm check` — format, lint, typecheck clean; 1793 tests passed in 52 files,
none skipped. `pnpm audit --prod`: no known vulnerabilities; full `pnpm audit`: 1 moderate,
dev-only (eslint>minimatch, GHSA-g3hv-75wg-m249). Workflow YAML parses. No e-mail sent.

2026-11-02, PR-07A after the Quality copy round (Node 22, pnpm 10.28.0, PostgreSQL 16,
pg_dump/pg_restore 16): `TEST_DATABASE_URL=postgres://radar:radar@localhost:5432/radar_test
REQUIRE_DB_TESTS=1 pnpm check` — format, lint, typecheck clean; 1793 tests passed in 52 files,
none skipped (run by the coder, C&S round 3 and Quality round 2). Quality also ran the RUNBOOK
restore drill by hand on scratch databases (dropped afterwards). No dependency changes; no
e-mail sent. The CI workflow has not run on GitHub yet.

2026-11-02, PR-07A C&S round-1 fixes (Node 22, pnpm 10.28.0, PostgreSQL 16, pg_dump/pg_restore
16): `TEST_DATABASE_URL=postgres://radar:radar@localhost:5432/radar_test REQUIRE_DB_TESTS=1
pnpm check` — format, lint, typecheck clean; 1793 tests passed in 52 files, none skipped (+15:
PG* refusal unit and integration tests, `status_internal_error` alert via the outbox and with
a failing send). No dependency changes; no e-mail sent; test schemas dropped by the teardown.

2026-11-02, PR-07A implementation (Node 22, pnpm 10.28.0, PostgreSQL 16, pg_dump/pg_restore 16):
`TEST_DATABASE_URL=postgres://radar:radar@localhost:5432/radar_test REQUIRE_DB_TESTS=1 pnpm check`
— format, lint, typecheck clean; 1778 tests passed in 52 files, none skipped, DB and
backup/restore tests included (PR-06B: 1658 in 47). No dependency changes. Test schemas dropped
by the global teardown; no e-mail sent (operator alerts only into temporary outboxes). The CI
workflow has not run on GitHub yet.

2026-11-02, PR-06B owner round (Node 22, pnpm 10.28.0, PostgreSQL 16):
`TEST_DATABASE_URL=postgres://radar:radar@localhost:5432/radar_test REQUIRE_DB_TESTS=1 pnpm check`
— format, lint, typecheck clean; 1658 tests passed in 47 files, DB tests included (84adc33:
1640 in 46). No dependency changes. New: `tests/web-matches-slot.test.ts` (fake timers: FIFO
hand-over, full queue, 3000 ms timeout, disconnect cleanup, closed client never takes the slot)
and real-server queue tests (wait → 200, full → 503, timeout → 503, disconnect leaves the
queue, hand-over after a failed computation). Quality probed a live `serve` with synthetic
`@example.invalid` data (queue timings above); scratch schema dropped, no e-mail sent. One
PR-06A assertion replaced by a stricter one (address shown exactly once on `/profil`, owner
requirement); the old 503 test's assertions moved into the queue tests, none dropped.
Working-tree fingerprint unchanged across every reviewer run.

2026-11-02, PR-06B after the final copy round (Node 22, pnpm 10.28.0, PostgreSQL 16):
`TEST_DATABASE_URL=postgres://radar:radar@localhost:5432/radar_test REQUIRE_DB_TESTS=1 pnpm check`
— format, lint, typecheck clean; 1640 tests passed in 46 files, DB tests included (PR-06A:
1526 in 43). Full `pnpm audit`: unchanged (1 moderate, dev-only minimatch via eslint). No
dependency changes. C&S probed a live `serve` in temporary schemas: the e-mail change vs a paused
login (5 rounds × 2 pause points: 303 in 15–46 ms, no 40P01; before the fix 500 after 1028 ms),
digest/change interleavings, CSRF fallback bounds (5 000 pairs → 403 in 6 ms), and the
`/dopasowania` stall (event-loop max 689 → 70–73 ms; concurrent `GET /` p50 22 ms). Quality ran
`serve` and `digest` (test mode) end to end with synthetic `@example.invalid` data. All schemas
and scratch files removed; no e-mail sent. Existing tests changed only where the copy was
removed on purpose (404 duplicate sentence, inactive-profile hint — both now assert presence of
the replacement and absence of the old text), the digest footer link texts (replaced by stricter
short-label assertions), the `strict-origin` expectation and POST
`/dostep` calls now sending `Origin`/`Sec-Fetch-Site`; no assertion weakened. Working-tree
fingerprint unchanged across every reviewer run.

2026-11-01, PR-06A owner follow-up `access:revoke` (Node 22, pnpm 10.28.0, PostgreSQL 16):
`TEST_DATABASE_URL=postgres://radar:radar@localhost:5432/radar_test REQUIRE_DB_TESTS=1 pnpm check`
— format, lint, typecheck clean; 1526/1526 tests passed in 43 files, DB tests included. Full
`pnpm audit`: unchanged (1 moderate, dev-only minimatch via eslint). No dependency changes.
Integration test: revoked login/unsubscribe links → 404, sessions → 401, other profile's
tokens and session still work, exact counts, repeat → 0/0. Quality ran `digest` (test mode),
`serve`, `access:link` and `access:revoke` end to end in a temporary schema, removed. C&S and
the coder ran read-only psql probes of the README lookup (apostrophe, injection string,
backslash). No e-mail sent; existing tests only gained new describe blocks and a stub option;
no assertion weakened. Working-tree fingerprint unchanged across every reviewer run.

2026-11-01, PR-06A after the copy round (Node 22, pnpm 10.28.0, PostgreSQL 16):
`TEST_DATABASE_URL=postgres://radar:radar@localhost:5432/radar_test REQUIRE_DB_TESTS=1 pnpm check`
— format, lint, typecheck clean; 1514/1514 tests passed in 43 files, DB tests included (PR-05:
1276 in 37). `pnpm audit --prod`: no known vulnerabilities; full `pnpm audit`: unchanged (1
moderate, dev-only minimatch via eslint). No dependency changes. C&S probed a live server
(HEAD, path tricks, missing Host, CL+TE, 413/415/431, hostile multipart bodies ≤ 0.13 ms,
slow header/body/drip cut at 10.01/15.01/15.01 s, DB outage, client aborts, outbox redaction)
in the scratchpad and temporary schemas, all removed. Quality ran `access:link` and `serve`
end to end with curl (login, reuse, CSRF, Origin, unsubscribe urlencoded + multipart, logout,
SIGTERM) and `digest` in test mode with and without `PUBLIC_BASE_URL` in temporary schemas,
all removed. No e-mail sent. Existing tests changed only for the new migration/table lists
(`0006_access`) and new describe blocks; no assertion weakened. Working-tree fingerprint
unchanged across every reviewer run.

2026-11-01, PR-05 owner-review round of PR #9 (`List-Unsubscribe`; Node 22, pnpm 10.28.0,
PostgreSQL 16): `TEST_DATABASE_URL=postgres://radar:radar@localhost:5432/radar_test REQUIRE_DB_TESTS=1 pnpm check`
— format, lint, typecheck clean; 1276/1276 tests passed in 37 files, DB tests included. `pnpm
audit`: unchanged (1 moderate, dev-only minimatch via eslint). C&S checked the header
construction against the installed nodemailer 10.1.7 source; no existing test changed; no
network sends (streamTransport and a temporary outbox only).

2026-11-01, PR-05 after fix round 3 (Node 22, pnpm 10.28.0, PostgreSQL 16):
`TEST_DATABASE_URL=postgres://radar:radar@localhost:5432/radar_test REQUIRE_DB_TESTS=1 pnpm check`
— format, lint, typecheck clean; 1262/1262 tests passed in 37 files, DB tests included (PR-04:
1105 in 32). `pnpm audit --prod`: no known vulnerabilities; full `pnpm audit`: unchanged (1
moderate, dev-only minimatch via eslint). No real e-mail sent: tests use `*.invalid`, `[::1]`
or a local fake SMTP server; C&S probed nodemailer's real EHLO error shapes on 127.0.0.1.
Quality ran `digest` (dry run, real run, re-run, next day, pending row, 52-offer overflow,
smtp to 127.0.0.1:1) in a temporary schema of radar_test with a scratch outbox; both removed
afterwards. Existing tests changed only for the new migration/table lists (`0005_deliveries`),
the shared lock helper and the deliberate CPV wording change.

2026-10-31, PR-04 owner-review round of PR #8 (Node 22, pnpm 10.28.0, PostgreSQL 16):
`TEST_DATABASE_URL=postgres://radar:radar@localhost:5432/radar_test REQUIRE_DB_TESTS=1 pnpm check`
— format, lint, typecheck clean; 1105/1105 tests passed in 32 files, DB tests included. C&S probes: region order (foreign voivodeship with
a listed county → mismatch; listed voivodeship with another county → match; non-normalizing
entries); warnings never print contact data, stdout stays one JSON line. Quality ran
`match:preview` against radar_test (temporary rows removed afterwards).

2026-10-31, PR-04 after the last fix round (Node 22, pnpm 10.28.0, PostgreSQL 16): C&S ran
`TEST_DATABASE_URL=postgres://radar:radar@localhost:5432/radar_test REQUIRE_DB_TESTS=1 pnpm check`
— format, lint, typecheck clean; 1099/1099 tests passed (32 files), DB tests included. Probes
(scratch only): 20 000 random de-duplication cases against a brute-force reference (0
differences); worst-case cost ~57 ms per pair; secret-marker probe of `profile:create` messages
and of skipped-row warnings (no value leaked). `pnpm audit`: unchanged (1 moderate, dev-only
minimatch via eslint).

2026-10-31, PR-03 Part C, owner-review follow-up of PR #7 (docs only: DECISIONS D-022,
PR_PLAN PR-04 AC5–AC7, STATE): C&S ran
`TEST_DATABASE_URL=postgres://radar:radar@localhost:5432/radar_test REQUIRE_DB_TESTS=1 pnpm check`
— format, lint, typecheck clean; 896/896 tests passed (28 files). D-022 examples were checked
against the real `normalizeCounty`/`comparableText`. No code or dependency changes.

2026-10-31, PR-03 Part C after the Quality re-review (Node 22, pnpm 10.28.0, PostgreSQL 16):
`TEST_DATABASE_URL=postgres://radar:radar@localhost:5432/radar_test REQUIRE_DB_TESTS=1 pnpm check`
— format, lint, typecheck clean; 896/896 tests passed (28 files; before PR-03C: 774 in 26
files). No dependency changes, no live network calls (captured fixtures only). Existing tests
changed only for the `warsaw-time` import path and where offers now carry real
description/contact/value (`tests/bzp-adapter.test.ts`, `tests/source-preview-cli.test.ts`:
expected `null` → fixture values). Working-tree fingerprint unchanged across every reviewer
run.

2026-10-30, PR-03 Part B after the Quality Review of the owner-review round (coordinator doc
nits only; README, DECISIONS D-021, STATE):
`TEST_DATABASE_URL=postgres://radar:radar@localhost:5432/radar_test REQUIRE_DB_TESTS=1 pnpm check`
— format, lint, typecheck clean; 774/774 tests passed (26 files). No code changes after
the Quality Review; no dependency changes, no live network calls.

2026-10-30, PR-03 Part B fix round after the C&S review of the owner-review round (Node 22,
pnpm 10.28.0, PostgreSQL 16):
`TEST_DATABASE_URL=postgres://radar:radar@localhost:5432/radar_test REQUIRE_DB_TESTS=1 pnpm check`
— format, lint, typecheck clean; 774/774 tests passed (26 files; owner-review round: 760). No
dependency changes, no live network calls.

2026-10-30, PR-03 Part B Quality Review fix round (documentation; `clipped` `from`/`to`
rename; `ingest` usage text; Node 22.22.0, pnpm 10.28.0, PostgreSQL 16):
`TEST_DATABASE_URL=postgres://radar:radar@localhost:5432/radar_test REQUIRE_DB_TESTS=1 pnpm check`
— format, lint, typecheck clean; 740/740 tests passed (26 files; same count as after the Code &
Safety fix round, which added 16 tests to the 724 below). No dependency changes, no live network
calls. Existing tests changed only for the `clipped` field rename (`firstSkipped`/`lastSkipped`
→ `from`/`to`) in `tests/catch-up.test.ts` and `tests/integration/catch-up.test.ts`.

2026-10-30, PR-03 Part B Coder session (Node 22.22.0, pnpm 10.28.0, PostgreSQL 16):
`TEST_DATABASE_URL=… REQUIRE_DB_TESTS=1 pnpm check` — format, lint, typecheck clean; 724/724
tests passed (26 files; before: 625 in 21 files). No dependency changes. No live network
calls (fixtures and fake sources only). Existing tests changed only where the contract changed
on purpose: BZP adapter request lists/document counts (+ `NoticeUpdateNotice`) and `kind`
guards, fake source `kind`, `runIngestion` request/outcome shape (`days`, `IngestionOutcome`),
`skipped` counter, exact migration lists (+ `0004`), ingest CLI usage/report shape (`mode`,
`from`, `to`, `notRun`, `clipped`, `publicationDate` per run), `source:preview` request lists
and `noticeUpdates`.

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
