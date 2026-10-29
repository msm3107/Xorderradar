import type { ColumnType, Generated } from "kysely";
import type { OpportunityStatus } from "../../domain/opportunity.js";

/**
 * Row types for the Kysely query builder. They mirror the SQL in
 * `migrations.ts` by hand (no codegen); integration tests catch drift.
 *
 * jsonb columns are written as JSON text (explicit `JSON.stringify`, so a value
 * is never mistaken for a PostgreSQL array literal by `pg`) and read back as
 * parsed JSON, which repositories validate before use.
 */
type Jsonb = ColumnType<unknown, string | null, string | null>;
/** Set by the database on insert and never written by the application. */
type ReadOnlyTimestamp = ColumnType<Date, never, never>;

export interface SourcesTable {
  id: string;
  name: string;
  base_url: string;
  enabled: boolean;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface OpportunitiesTable {
  id: Generated<string>;
  source_id: string;
  source_url: string;
  external_id: string | null;
  issuer_name: string;
  title: string;
  description: string | null;
  location: Jsonb;
  published_at: Date | null;
  deadline: Date | null;
  /** numeric → string in `pg`; never converted to a JS number. */
  estimated_value: string | null;
  currency: string | null;
  categories: string[];
  contact: Jsonb;
  fetched_at: Date;
  first_seen_at: ReadOnlyTimestamp;
  updated_at: Generated<Date>;
  fingerprint: string;
  content_hash: string;
  status: OpportunityStatus;
}

export interface CompanyProfilesTable {
  id: Generated<string>;
  email: string;
  name: string;
  categories: string[];
  include_keywords: string[];
  exclude_keywords: string[];
  voivodeships: string[];
  counties: string[];
  active: boolean;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface Database {
  sources: SourcesTable;
  opportunities: OpportunitiesTable;
  company_profiles: CompanyProfilesTable;
}
