import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * All schema migrations, in order. Static on purpose: an imported record (no
 * directory scanning) works the same from `src/` (tsx) and `dist/` (tsc).
 *
 * Rules:
 * - Names sort lexicographically in application order (`NNNN_description`);
 *   the migrator refuses to run when an applied migration is missing or out of
 *   order.
 * - Never edit a migration that may have run anywhere; add a new one.
 * - Each step is explicit SQL. All pending migrations run in one transaction
 *   (PostgreSQL has transactional DDL), so a failure leaves the schema as it was.
 * - No `down` migrations: rollback = restore from backup or a new forward
 *   migration (docs/SECURITY.md §14 — not every migration is reversible).
 */
export const migrations: Readonly<Record<string, Migration>> = {
  "0001_core_schema": {
    async up(db: Kysely<unknown>) {
      await sql`
        CREATE TABLE sources (
          id text PRIMARY KEY,
          name text NOT NULL,
          base_url text NOT NULL,
          enabled boolean NOT NULL DEFAULT true,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `.execute(db);

      await sql`
        CREATE TABLE opportunities (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          source_id text NOT NULL REFERENCES sources (id),
          source_url text NOT NULL,
          external_id text,
          issuer_name text NOT NULL,
          title text NOT NULL,
          description text,
          location jsonb,
          published_at timestamptz,
          deadline timestamptz,
          estimated_value numeric,
          currency char(3),
          categories text[] NOT NULL DEFAULT '{}',
          contact jsonb,
          fetched_at timestamptz NOT NULL,
          first_seen_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          fingerprint text NOT NULL,
          content_hash text NOT NULL,
          status text NOT NULL,
          CONSTRAINT opportunities_fingerprint_key UNIQUE (fingerprint),
          -- numeric also accepts 'NaN' and '±Infinity'; neither is an amount. PostgreSQL
          -- orders NaN above Infinity, so the upper bound rejects both.
          CONSTRAINT opportunities_estimated_value_check
            CHECK (estimated_value IS NULL
                   OR (estimated_value >= 0 AND estimated_value < 'Infinity')),
          CONSTRAINT opportunities_value_currency_check
            CHECK ((estimated_value IS NULL) = (currency IS NULL)),
          CONSTRAINT opportunities_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
          CONSTRAINT opportunities_status_check
            CHECK (status IN ('open', 'closed', 'cancelled', 'unknown')),
          CONSTRAINT opportunities_location_check
            CHECK (location IS NULL OR jsonb_typeof(location) = 'object'),
          CONSTRAINT opportunities_contact_check
            CHECK (contact IS NULL OR jsonb_typeof(contact) = 'object')
        )
      `.execute(db);

      // Partial: notices without a source-assigned id rely on the fingerprint only.
      await sql`
        CREATE UNIQUE INDEX opportunities_source_external_id_key
          ON opportunities (source_id, external_id)
          WHERE external_id IS NOT NULL
      `.execute(db);

      await sql`
        CREATE TABLE company_profiles (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          email text NOT NULL,
          name text NOT NULL,
          categories text[] NOT NULL DEFAULT '{}',
          include_keywords text[] NOT NULL DEFAULT '{}',
          exclude_keywords text[] NOT NULL DEFAULT '{}',
          voivodeships text[] NOT NULL DEFAULT '{}',
          counties text[] NOT NULL DEFAULT '{}',
          active boolean NOT NULL DEFAULT true,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT company_profiles_email_key UNIQUE (email),
          -- Uniqueness is only meaningful on the normalized form.
          CONSTRAINT company_profiles_email_check CHECK (email = lower(btrim(email)))
        )
      `.execute(db);
    },
  },

  "0002_ingestion_runs": {
    async up(db: Kysely<unknown>) {
      // One row per source per `ingest` run (docs/ARCHITECTURE.md §7). Only
      // counters and short codes: never document content or personal data.
      await sql`
        CREATE TABLE ingestion_runs (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          source_id text NOT NULL,
          publication_date date NOT NULL,
          max_records integer NOT NULL,
          started_at timestamptz NOT NULL,
          finished_at timestamptz NOT NULL,
          status text NOT NULL,
          documents integer NOT NULL,
          extracted integer NOT NULL,
          inserted integer NOT NULL,
          updated integer NOT NULL,
          unchanged integer NOT NULL,
          rejected integer NOT NULL,
          incomplete jsonb NOT NULL DEFAULT '[]',
          error_code text,
          CONSTRAINT ingestion_runs_source_id_fkey
            FOREIGN KEY (source_id) REFERENCES sources (id),
          CONSTRAINT ingestion_runs_max_records_check CHECK (max_records > 0),
          CONSTRAINT ingestion_runs_finished_at_check CHECK (finished_at >= started_at),
          CONSTRAINT ingestion_runs_status_check
            CHECK (status IN ('succeeded', 'incomplete', 'failed')),
          CONSTRAINT ingestion_runs_counters_check
            CHECK (documents >= 0 AND extracted >= 0 AND inserted >= 0 AND updated >= 0
                   AND unchanged >= 0 AND rejected >= 0),
          CONSTRAINT ingestion_runs_incomplete_check CHECK (jsonb_typeof(incomplete) = 'array'),
          -- A short machine code (e.g. http_status, invalid_document), never a message.
          CONSTRAINT ingestion_runs_error_code_check
            CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
          -- Mirrors the domain rule: a code exactly when the run failed.
          CONSTRAINT ingestion_runs_error_code_status_check
            CHECK ((status = 'failed') = (error_code IS NOT NULL))
        )
      `.execute(db);

      await sql`
        CREATE INDEX ingestion_runs_source_started_idx
          ON ingestion_runs (source_id, started_at DESC)
      `.execute(db);

      // The first source (D-015). An existing row (e.g. disabled by the
      // operator) is left exactly as it is.
      await sql`
        INSERT INTO sources (id, name, base_url, enabled)
        VALUES ('bzp', 'Biuletyn Zamówień Publicznych', 'https://ezamowienia.gov.pl/', true)
        ON CONFLICT (id) DO NOTHING
      `.execute(db);
    },
  },

  "0003_opportunities_tender_id": {
    async up(db: Kysely<unknown>) {
      // The source's procedure id (BZP: OCDS `tenderId`, D-015); null when the
      // source does not give one. Rows stored before this migration stay null
      // until they are fetched again. Lengths are bounded by the domain schema,
      // like the other text columns.
      await sql`ALTER TABLE opportunities ADD COLUMN tender_id text`.execute(db);

      // Not unique: one procedure has several notices (the notice and the
      // notices that change it). PR-03B looks the original up by this id.
      await sql`
        CREATE INDEX opportunities_source_tender_id_idx
          ON opportunities (source_id, tender_id)
          WHERE tender_id IS NOT NULL
      `.execute(db);
    },
  },

  "0004_notice_updates": {
    async up(db: Kysely<unknown>) {
      // Which update notice set the stored deadline (D-015): its number and
      // publication time, both null until an update is applied. They decide
      // which of several updates wins (the latest published) and keep the
      // deadline when the original notice is fetched again. Existing rows
      // stay null. Bound as the domain's notice numbers (text(200)).
      await sql`
        ALTER TABLE opportunities
          ADD COLUMN deadline_update_notice text,
          ADD COLUMN deadline_update_published_at timestamptz,
          ADD CONSTRAINT opportunities_deadline_update_check
            CHECK ((deadline_update_notice IS NULL) = (deadline_update_published_at IS NULL)),
          ADD CONSTRAINT opportunities_deadline_update_notice_check
            CHECK (char_length(deadline_update_notice) BETWEEN 1 AND 200)
      `.execute(db);

      // Records read but deliberately not applied (e.g. an update whose
      // original is not stored). Earlier runs had none: default 0.
      await sql`
        ALTER TABLE ingestion_runs
          ADD COLUMN skipped integer NOT NULL DEFAULT 0,
          ADD CONSTRAINT ingestion_runs_skipped_check CHECK (skipped >= 0)
      `.execute(db);
    },
  },

  "0005_deliveries": {
    async up(db: Kysely<unknown>) {
      // One row per offer sent (or being sent) to a profile over one transport
      // (D-024). The unique key makes delivery at-most-once: a row is claimed
      // (pending) before the e-mail is sent and never inserted twice. Only a
      // short error code is stored, never a server message or an address.
      await sql`
        CREATE TABLE deliveries (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          profile_id uuid NOT NULL,
          opportunity_id uuid NOT NULL,
          transport text NOT NULL,
          digest_date date NOT NULL,
          status text NOT NULL,
          attempts integer NOT NULL DEFAULT 0,
          error_code text,
          created_at timestamptz NOT NULL DEFAULT now(),
          sent_at timestamptz,
          -- Deleting a profile deletes its delivery history; offers are never deleted.
          CONSTRAINT deliveries_profile_id_fkey
            FOREIGN KEY (profile_id) REFERENCES company_profiles (id) ON DELETE CASCADE,
          CONSTRAINT deliveries_opportunity_id_fkey
            FOREIGN KEY (opportunity_id) REFERENCES opportunities (id),
          CONSTRAINT deliveries_profile_opportunity_transport_key
            UNIQUE (profile_id, opportunity_id, transport),
          CONSTRAINT deliveries_transport_check CHECK (transport IN ('test', 'smtp')),
          CONSTRAINT deliveries_status_check CHECK (status IN ('pending', 'sent', 'failed')),
          CONSTRAINT deliveries_attempts_check CHECK (attempts >= 0),
          CONSTRAINT deliveries_error_code_check
            CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
          CONSTRAINT deliveries_error_code_status_check
            CHECK ((status = 'failed') = (error_code IS NOT NULL)),
          CONSTRAINT deliveries_sent_at_check CHECK ((status = 'sent') = (sent_at IS NOT NULL))
        )
      `.execute(db);

      // "Has this profile had its digest today?" (the unique key's index
      // already serves lookups by profile).
      await sql`
        CREATE INDEX deliveries_profile_transport_date_idx
          ON deliveries (profile_id, transport, digest_date)
      `.execute(db);
    },
  },
  "0006_access": {
    async up(db: Kysely<unknown>) {
      // Secret tokens from e-mails (D-026): a single-use login link and a
      // multi-use unsubscribe link (RFC 8058). Only SHA-256 of the token is
      // stored (hex), never the token itself. Expiry in hours, not days:
      // `timestamptz + interval 'N days'` follows the session time zone across
      // a DST change, hours do not.
      await sql`
        CREATE TABLE access_tokens (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          token_hash text NOT NULL,
          profile_id uuid NOT NULL,
          purpose text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          expires_at timestamptz NOT NULL,
          used_at timestamptz,
          CONSTRAINT access_tokens_token_hash_key UNIQUE (token_hash),
          CONSTRAINT access_tokens_profile_id_fkey
            FOREIGN KEY (profile_id) REFERENCES company_profiles (id) ON DELETE CASCADE,
          CONSTRAINT access_tokens_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
          CONSTRAINT access_tokens_purpose_check CHECK (purpose IN ('login', 'unsubscribe')),
          CONSTRAINT access_tokens_expiry_check
            CHECK (expires_at > created_at
                   AND expires_at <= created_at + CASE purpose
                     WHEN 'login' THEN interval '168 hours'
                     ELSE interval '1440 hours'
                   END),
          -- Only a login token is used up; an unsubscribe token works until it expires.
          CONSTRAINT access_tokens_used_at_check CHECK (used_at IS NULL OR purpose = 'login')
        )
      `.execute(db);
      // The cascade from company_profiles and the cleanup of expired rows.
      await sql`CREATE INDEX access_tokens_profile_id_idx ON access_tokens (profile_id)`.execute(
        db,
      );
      await sql`CREATE INDEX access_tokens_expires_at_idx ON access_tokens (expires_at)`.execute(
        db,
      );

      // Browser sessions after a login link (cookie `__Host-radar_sesja`): the
      // random session id is stored as SHA-256 only.
      await sql`
        CREATE TABLE sessions (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          token_hash text NOT NULL,
          profile_id uuid NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          expires_at timestamptz NOT NULL,
          CONSTRAINT sessions_token_hash_key UNIQUE (token_hash),
          CONSTRAINT sessions_profile_id_fkey
            FOREIGN KEY (profile_id) REFERENCES company_profiles (id) ON DELETE CASCADE,
          CONSTRAINT sessions_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
          CONSTRAINT sessions_expiry_check
            CHECK (expires_at > created_at AND expires_at <= created_at + interval '720 hours')
        )
      `.execute(db);
      await sql`CREATE INDEX sessions_profile_id_idx ON sessions (profile_id)`.execute(db);
      await sql`CREATE INDEX sessions_expires_at_idx ON sessions (expires_at)`.execute(db);
    },
  },
};
