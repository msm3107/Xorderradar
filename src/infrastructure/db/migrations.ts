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
};
