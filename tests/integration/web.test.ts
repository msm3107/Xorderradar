import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defaultCliDeps, ExitCode, runCli } from "../../src/cli.js";
import type { CompanyProfile, CompanyProfileInput } from "../../src/domain/company-profile.js";
import {
  consumeLoginToken,
  deleteExpiredAccess,
  hashSecretToken,
  issueAccessToken,
  newSecretToken,
} from "../../src/infrastructure/db/access-repository.js";
import {
  createCompanyProfile,
  deleteCompanyProfile,
} from "../../src/infrastructure/db/company-profiles-repository.js";
import { migrateToLatest } from "../../src/infrastructure/db/database.js";
import { createLogger } from "../../src/infrastructure/logger.js";
import { csrfTokenFor, SESSION_COOKIE } from "../../src/web/session.js";
import { startWebServer, type WebServer } from "../../src/web/server.js";
import { createTestSchema, skipWithoutDatabase, type TestSchema } from "./test-database.js";

/*
 * PR-06A with PostgreSQL: a real server on 127.0.0.1 (ephemeral port),
 * driven with fetch. Pseudonymised data only; nothing leaves the machine.
 */

const BASE = "https://radar.example.invalid";
const FORM = "application/x-www-form-urlencoded";
const EMAIL = "kontakt@example.invalid";

const profileInput = {
  email: EMAIL,
  name: "Jan Kowalski <Elektryka> & syn",
  categories: ["elektryka"],
  includeKeywords: ["oświetlenie"],
  excludeKeywords: [],
  voivodeships: ["mazowieckie"],
  counties: [],
  active: true,
} satisfies CompanyProfileInput;

describe.skipIf(skipWithoutDatabase)("web access (PostgreSQL)", () => {
  let schema: TestSchema;
  let server: WebServer;
  let url = "";
  let profile: CompanyProfile;
  const logs: string[] = [];

  beforeAll(async () => {
    schema = await createTestSchema();
    await migrateToLatest(schema.db);
    server = await startWebServer({
      db: schema.db,
      publicBaseUrl: BASE,
      logger: createLogger("debug", (line) => logs.push(line)),
      host: "127.0.0.1",
      port: 0,
      cleanupIntervalMs: null,
    });
    url = `http://127.0.0.1:${String(server.port)}`;
  });
  afterAll(async () => {
    await server.close();
    await schema.close();
  });
  beforeEach(async () => {
    await sql`DELETE FROM company_profiles`.execute(schema.db);
    profile = await createCompanyProfile(schema.db, profileInput);
  });

  function post(path: string, body: string, headers: Record<string, string> = {}) {
    return fetch(`${url}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": FORM, ...headers },
      body,
    });
  }

  /** The `name=value` of the Set-Cookie header, to send back as Cookie. */
  function cookiePair(response: Response): string {
    const header = response.headers.get("set-cookie") ?? "";
    return header.split(";")[0] ?? "";
  }

  async function login(): Promise<{ cookie: string; token: string }> {
    const issued = await issueAccessToken(schema.db, profile.id, "login");
    const response = await post("/dostep", `token=${issued.token}`, { origin: BASE });
    expect(response.status).toBe(303);
    const cookie = cookiePair(response);
    return { cookie, token: cookie.slice(`${SESSION_COOKIE}=`.length) };
  }

  async function profileActive(): Promise<boolean> {
    const row = await schema.db
      .selectFrom("company_profiles")
      .select("active")
      .where("id", "=", profile.id)
      .executeTakeFirstOrThrow();
    return row.active;
  }

  async function invalidLinkBody(): Promise<string> {
    const response = await fetch(`${url}/dostep/${newSecretToken()}`);
    expect(response.status).toBe(404);
    return response.text();
  }

  describe("login link", () => {
    it("shows a confirmation on GET without using the link up", async () => {
      const issued = await issueAccessToken(schema.db, profile.id, "login");
      for (let i = 0; i < 3; i++) {
        const page = await fetch(`${url}/dostep/${issued.token}`);
        expect(page.status).toBe(200);
        expect(page.headers.get("cache-control")).toBe("no-store");
        expect(page.headers.get("set-cookie")).toBeNull();
        const html = await page.text();
        expect(html).toContain('<form method="post" action="/dostep">');
        expect(html).toContain(`<input type="hidden" name="token" value="${issued.token}">`);
        expect(html).toContain('<button type="submit">Zaloguj się</button>');
      }
      const row = await schema.db
        .selectFrom("access_tokens")
        .select(["used_at", "token_hash"])
        .executeTakeFirstOrThrow();
      expect(row.used_at).toBeNull();
      // Only the hash is stored.
      expect(row.token_hash).toBe(hashSecretToken(issued.token));
      expect(row.token_hash).not.toContain(issued.token);
    });

    it("opens a session on POST with a __Host- cookie, once only", async () => {
      const issued = await issueAccessToken(schema.db, profile.id, "login");
      const first = await post("/dostep", `token=${issued.token}`, { origin: BASE });
      expect(first.status).toBe(303);
      expect(first.headers.get("location")).toBe("/profil");
      expect(first.headers.get("cache-control")).toBe("no-store");
      const setCookie = first.headers.get("set-cookie") ?? "";
      const [pair, ...attributes] = setCookie.split("; ");
      expect(pair).toMatch(new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}$`));
      expect(attributes.sort()).toEqual(
        ["HttpOnly", "Max-Age=2592000", "Path=/", "SameSite=Lax", "Secure"].sort(),
      );
      const sessionToken = (pair ?? "").split("=")[1] ?? "";
      const session = await schema.db
        .selectFrom("sessions")
        .select(["token_hash", "profile_id"])
        .select(sql<number>`extract(epoch FROM expires_at - created_at)::int`.as("ttl"))
        .executeTakeFirstOrThrow();
      expect(session).toEqual({
        token_hash: hashSecretToken(sessionToken),
        profile_id: profile.id,
        ttl: 30 * 24 * 3600,
      });

      const neutral = await invalidLinkBody();
      const second = await post("/dostep", `token=${issued.token}`, { origin: BASE });
      expect(second.status).toBe(404);
      expect(second.headers.get("set-cookie")).toBeNull();
      expect(await second.text()).toBe(neutral);
      const again = await fetch(`${url}/dostep/${issued.token}`);
      expect(again.status).toBe(404);
      expect(await again.text()).toBe(neutral);
    });

    it("shows one neutral page for unknown, malformed, expired and unsubscribe tokens", async () => {
      const neutral = await invalidLinkBody();
      const expired = await issueAccessToken(schema.db, profile.id, "login");
      await sql`UPDATE access_tokens SET created_at = now() - interval '8 days',
                expires_at = now() - interval '1 day'`.execute(schema.db);
      const unsubscribe = await issueAccessToken(schema.db, profile.id, "unsubscribe");
      for (const token of [expired.token, unsubscribe.token, "nie-token", "a".repeat(43)]) {
        const page = await fetch(`${url}/dostep/${token}`);
        expect(page.status).toBe(404);
        expect(await page.text()).toBe(neutral);
        const submitted = await post("/dostep", `token=${encodeURIComponent(token)}`, {
          origin: BASE,
        });
        expect(submitted.status).toBe(404);
        expect(await submitted.text()).toBe(neutral);
      }
      expect(await schema.db.selectFrom("sessions").select("id").execute()).toEqual([]);
    });

    it("lets only one of two concurrent uses open a session", async () => {
      const issued = await issueAccessToken(schema.db, profile.id, "login");
      const results = await Promise.all(
        Array.from({ length: 5 }, () => consumeLoginToken(schema.db, issued.token)),
      );
      expect(results.filter((result) => result !== null)).toHaveLength(1);
      expect(await schema.db.selectFrom("sessions").select("id").execute()).toHaveLength(1);
    });

    it("refuses a login POST from a foreign Origin without using the link up", async () => {
      const issued = await issueAccessToken(schema.db, profile.id, "login");
      const response = await post("/dostep", `token=${issued.token}`, {
        origin: "https://evil.example.invalid",
      });
      expect(response.status).toBe(403);
      expect(await response.text()).toContain("otwórz link w innej, aktualnej przeglądarce");
      expect((await fetch(`${url}/dostep/${issued.token}`)).status).toBe(200);
    });

    // Login CSRF (PR-06B): without a session there is no CSRF token, so the
    // request must provably come from our own confirmation page.
    it.each([
      ["Origin = PUBLIC_BASE_URL", { origin: BASE }],
      ["no Origin, Sec-Fetch-Site: same-origin", { "sec-fetch-site": "same-origin" }],
    ])("accepts a login POST with %s", async (_label, headers) => {
      const issued = await issueAccessToken(schema.db, profile.id, "login");
      const response = await post("/dostep", `token=${issued.token}`, headers);
      expect(response.status).toBe(303);
      expect(response.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=`);
    });

    it.each([
      ["no Origin, Sec-Fetch-Site: cross-site", { "sec-fetch-site": "cross-site" }],
      ["no Origin, Sec-Fetch-Site: same-site", { "sec-fetch-site": "same-site" }],
      ["no Origin, Sec-Fetch-Site: none", { "sec-fetch-site": "none" }],
      ["neither header", {}],
      ["Origin: null", { origin: "null", "sec-fetch-site": "same-origin" }],
    ])("refuses a login POST with %s (403) without using the link up", async (_label, headers) => {
      const issued = await issueAccessToken(schema.db, profile.id, "login");
      const response = await post("/dostep", `token=${issued.token}`, headers);
      expect(response.status).toBe(403);
      expect(await response.text()).toContain("otwórz link w innej, aktualnej przeglądarce");
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await schema.db.selectFrom("sessions").select("id").execute()).toEqual([]);
      expect((await fetch(`${url}/dostep/${issued.token}`)).status).toBe(200);
    });
  });

  describe("session", () => {
    it("shows the signed-in profile only, escaped, with CSRF-protected forms", async () => {
      const { cookie, token } = await login();
      const page = await fetch(`${url}/profil`, { headers: { cookie } });
      expect(page.status).toBe(200);
      expect(page.headers.get("cache-control")).toBe("no-store");
      const html = await page.text();
      expect(html).toContain("Jan Kowalski &lt;Elektryka&gt; &amp; syn");
      expect(html).toContain("włączone");
      expect(html).not.toContain(profile.id);
      expect(html).not.toContain(EMAIL);
      expect(html).not.toContain(token);
      const csrf = csrfTokenFor(token);
      expect(html.match(new RegExp(`name="csrf" value="${csrf}"`, "g"))).toHaveLength(2);
    });

    it("answers 401 without a valid session and clears a stale cookie", async () => {
      expect((await fetch(`${url}/profil`)).status).toBe(401);
      const unknown = await fetch(`${url}/profil`, {
        headers: { cookie: `${SESSION_COOKIE}=${newSecretToken()}` },
      });
      expect(unknown.status).toBe(401);
      expect(unknown.headers.get("set-cookie")).toContain("Max-Age=0");

      const { cookie } = await login();
      await sql`UPDATE sessions SET created_at = now() - interval '31 days',
                expires_at = now() - interval '1 day'`.execute(schema.db);
      const expired = await fetch(`${url}/profil`, { headers: { cookie } });
      expect(expired.status).toBe(401);
      const post401 = await post("/wyloguj", `csrf=x`, { cookie });
      expect(post401.status).toBe(401);
    });

    it("refuses POSTs with a missing or wrong CSRF token or a foreign Origin (403)", async () => {
      const { cookie, token } = await login();
      const other = csrfTokenFor(newSecretToken());
      const csrf = csrfTokenFor(token);
      for (const path of ["/profil/wypisz", "/wyloguj"]) {
        expect((await post(path, "", { cookie })).status).toBe(403);
        expect((await post(path, "x=1", { cookie })).status).toBe(403);
        expect((await post(path, `csrf=${other}`, { cookie })).status).toBe(403);
        expect((await post(path, `csrf=${csrf}&csrf=${csrf}`, { cookie })).status).toBe(403);
        expect(
          (await post(path, `csrf=${csrf}`, { cookie, origin: "https://evil.example.invalid" }))
            .status,
        ).toBe(403);
      }
      expect(await profileActive()).toBe(true);
      expect(await schema.db.selectFrom("sessions").select("id").execute()).toHaveLength(1);
    });

    it("switches notifications off from the profile page", async () => {
      const { cookie, token } = await login();
      const response = await post("/profil/wypisz", `csrf=${csrfTokenFor(token)}`, {
        cookie,
        origin: BASE,
      });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/profil");
      expect(await profileActive()).toBe(false);
      const html = await (await fetch(`${url}/profil`, { headers: { cookie } })).text();
      expect(html).toContain("wyłączone");
      expect(html).not.toContain("/profil/wypisz");
    });

    it("logs out: deletes the session and clears the cookie", async () => {
      const { cookie, token } = await login();
      const response = await post("/wyloguj", `csrf=${csrfTokenFor(token)}`, { cookie });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/");
      expect(response.headers.get("set-cookie")).toBe(
        `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
      );
      expect(await schema.db.selectFrom("sessions").select("id").execute()).toEqual([]);
      expect((await fetch(`${url}/profil`, { headers: { cookie } })).status).toBe(401);
    });

    it("ends every session and token of a deleted profile (ON DELETE CASCADE)", async () => {
      const { cookie } = await login();
      await issueAccessToken(schema.db, profile.id, "unsubscribe");
      await deleteCompanyProfile(schema.db, profile.id);
      expect(await schema.db.selectFrom("sessions").select("id").execute()).toEqual([]);
      expect(await schema.db.selectFrom("access_tokens").select("id").execute()).toEqual([]);
      expect((await fetch(`${url}/profil`, { headers: { cookie } })).status).toBe(401);
    });
  });

  describe("one-click unsubscribe", () => {
    it("shows a confirmation on GET and changes nothing", async () => {
      const issued = await issueAccessToken(schema.db, profile.id, "unsubscribe");
      const page = await fetch(`${url}/wypis/${issued.token}`);
      expect(page.status).toBe(200);
      expect(page.headers.get("cache-control")).toBe("no-store");
      const html = await page.text();
      expect(html).toContain(`<form method="post" action="/wypis/${issued.token}">`);
      expect(html).toContain('name="List-Unsubscribe" value="One-Click"');
      expect(html).toContain('<button type="submit">Wypisz mnie</button>');
      expect(await profileActive()).toBe(true);
    });

    it("unsubscribes on the RFC 8058 POST without a cookie, idempotently", async () => {
      const issued = await issueAccessToken(schema.db, profile.id, "unsubscribe");
      const first = await post(`/wypis/${issued.token}`, "List-Unsubscribe=One-Click", {
        // A mail provider posts from its own servers.
        origin: "https://mail.example.invalid",
      });
      expect(first.status).toBe(200);
      expect(await first.text()).toContain("Powiadomienia e-mail zostały wyłączone");
      expect(await profileActive()).toBe(false);
      const { updated_at: after } = await schema.db
        .selectFrom("company_profiles")
        .select("updated_at")
        .executeTakeFirstOrThrow();

      const second = await post(`/wypis/${issued.token}`, "List-Unsubscribe=One-Click");
      expect(second.status).toBe(200);
      const row = await schema.db
        .selectFrom("company_profiles")
        .select(["active", "updated_at"])
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ active: false, updated_at: after });
      // Reusable: the token is not used up, and still valid for GET.
      expect((await fetch(`${url}/wypis/${issued.token}`)).status).toBe(200);
    });

    describe("as multipart/form-data (RFC 8058 §3.2 SHOULD)", () => {
      const RFC_BOUNDARY = "---FormBoundaryjWmhtjORrn";

      function postMultipart(token: string, contentType: string, body: string) {
        return fetch(`${url}/wypis/${token}`, {
          method: "POST",
          redirect: "manual",
          headers: { "content-type": contentType, origin: "https://mail.example.invalid" },
          body,
        });
      }

      it("unsubscribes on the RFC 8058 §8.3 body: 200, no redirect, no cookie, idempotent", async () => {
        const issued = await issueAccessToken(schema.db, profile.id, "unsubscribe");
        // §8.3, with the RFC 2046 "--" before the boundary on the delimiter lines.
        const body = [
          `--${RFC_BOUNDARY}`,
          'Content-Disposition: form-data; name="List-Unsubscribe"',
          "",
          "One-Click",
          `--${RFC_BOUNDARY}--`,
        ].join("\r\n");
        const contentType = `multipart/form-data; boundary=${RFC_BOUNDARY}`;

        const first = await postMultipart(issued.token, contentType, body);
        // RFC 8058 §3.2: the sender MUST NOT answer with a redirect.
        expect(first.status).toBe(200);
        expect(first.headers.get("location")).toBeNull();
        expect(first.headers.get("set-cookie")).toBeNull();
        expect(await first.text()).toContain("Powiadomienia e-mail zostały wyłączone");
        expect(await profileActive()).toBe(false);
        const { updated_at: after } = await schema.db
          .selectFrom("company_profiles")
          .select("updated_at")
          .executeTakeFirstOrThrow();

        const second = await postMultipart(issued.token, contentType, body);
        expect(second.status).toBe(200);
        expect(second.headers.get("location")).toBeNull();
        const row = await schema.db
          .selectFrom("company_profiles")
          .select(["active", "updated_at"])
          .executeTakeFirstOrThrow();
        expect(row).toEqual({ active: false, updated_at: after });
      });

      it("accepts a quoted boundary and ignores other parts", async () => {
        const issued = await issueAccessToken(schema.db, profile.id, "unsubscribe");
        const body = [
          "--a boundary",
          'Content-Disposition: form-data; name="source"',
          "",
          "kontakt@example.invalid",
          "--a boundary",
          'Content-Disposition: form-data; name="List-Unsubscribe"',
          "",
          "One-Click",
          "--a boundary--",
          "",
        ].join("\r\n");
        const response = await postMultipart(
          issued.token,
          'multipart/form-data; boundary="a boundary"',
          body,
        );
        expect(response.status).toBe(200);
        expect(await profileActive()).toBe(false);
      });

      it("shows the neutral page for an unknown token and changes nothing", async () => {
        const body = [
          "--b",
          'Content-Disposition: form-data; name="List-Unsubscribe"',
          "",
          "One-Click",
          "--b--",
        ].join("\r\n");
        const response = await postMultipart(
          newSecretToken(),
          "multipart/form-data; boundary=b",
          body,
        );
        expect(response.status).toBe(404);
        expect(await response.text()).toBe(await invalidLinkBody());
        expect(await profileActive()).toBe(true);
      });
    });

    it("pins a 200 (never a redirect) for the urlencoded one-click POST too", async () => {
      const issued = await issueAccessToken(schema.db, profile.id, "unsubscribe");
      const response = await post(`/wypis/${issued.token}`, "List-Unsubscribe=One-Click");
      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("set-cookie")).toBeNull();
    });

    it("needs the exact one-click body, a live unsubscribe token and a form body", async () => {
      const issued = await issueAccessToken(schema.db, profile.id, "unsubscribe");
      for (const body of ["", "List-Unsubscribe=Yes", "List-Unsubscribe=One-Click&x=1"]) {
        expect((await post(`/wypis/${issued.token}`, body)).status).toBe(400);
      }
      const text = await fetch(`${url}/wypis/${issued.token}`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "List-Unsubscribe=One-Click",
      });
      expect(text.status).toBe(415);
      const login = await issueAccessToken(schema.db, profile.id, "login");
      expect((await post(`/wypis/${login.token}`, "List-Unsubscribe=One-Click")).status).toBe(404);
      expect((await post(`/wypis/${newSecretToken()}`, "List-Unsubscribe=One-Click")).status).toBe(
        404,
      );
      await sql`UPDATE access_tokens SET created_at = now() - interval '61 days',
                expires_at = now() - interval '1 day'
                WHERE purpose = 'unsubscribe'`.execute(schema.db);
      expect((await post(`/wypis/${issued.token}`, "List-Unsubscribe=One-Click")).status).toBe(404);
      expect((await fetch(`${url}/wypis/${issued.token}`)).status).toBe(404);
      expect(await profileActive()).toBe(true);
    });
  });

  it("never logs a token, cookie, path or address", async () => {
    logs.length = 0;
    const issued = await issueAccessToken(schema.db, profile.id, "login");
    const unsubscribe = await issueAccessToken(schema.db, profile.id, "unsubscribe");
    await fetch(`${url}/dostep/${issued.token}?q=${issued.token}`);
    const opened = await post("/dostep", `token=${issued.token}`, {
      "sec-fetch-site": "same-origin",
    });
    const cookie = cookiePair(opened);
    await fetch(`${url}/profil`, { headers: { cookie } });
    await fetch(`${url}/wypis/${unsubscribe.token}`);
    await post(`/wypis/${unsubscribe.token}`, "List-Unsubscribe=One-Click");
    const text = logs.join("");
    for (const secret of [issued.token, unsubscribe.token, cookie.split("=")[1] ?? "", EMAIL]) {
      expect(secret).not.toBe("");
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain("/dostep");
    expect(text).not.toContain("/wypis");
    const routes = logs.map((line) => (JSON.parse(line) as { route: string }).route);
    expect(routes).toEqual(["login_link", "login", "profile", "unsubscribe", "unsubscribe"]);
  });

  it("deletes expired tokens and sessions in bounded batches", async () => {
    // Two expired tokens (one unused, one used by the first login) and an expired session.
    await issueAccessToken(schema.db, profile.id, "login");
    await login();
    await sql`UPDATE access_tokens SET created_at = now() - interval '7 days',
              expires_at = now() - interval '1 second'`.execute(schema.db);
    // Live: an unsubscribe token, the second login's used token and its session.
    const live = await issueAccessToken(schema.db, profile.id, "unsubscribe");
    await login();
    await sql`UPDATE sessions SET created_at = now() - interval '30 days',
              expires_at = now() - interval '1 second'
              WHERE id = (SELECT id FROM sessions ORDER BY created_at LIMIT 1)`.execute(schema.db);

    expect(await deleteExpiredAccess(schema.db, 1)).toEqual({ tokens: 1, sessions: 1 });
    expect(await deleteExpiredAccess(schema.db, 1)).toEqual({ tokens: 1, sessions: 0 });
    expect(await deleteExpiredAccess(schema.db)).toEqual({ tokens: 0, sessions: 0 });
    const tokens = await schema.db.selectFrom("access_tokens").select("token_hash").execute();
    expect(tokens.map((row) => row.token_hash)).toContain(hashSecretToken(live.token));
    expect(tokens).toHaveLength(2);
    expect(await schema.db.selectFrom("sessions").select("id").execute()).toHaveLength(1);
  });

  it("enforces the token and session constraints", async () => {
    const insert = (values: Record<string, unknown>) =>
      sql`INSERT INTO access_tokens (token_hash, profile_id, purpose, expires_at, used_at)
          VALUES (${values.hash ?? hashSecretToken(newSecretToken())}, ${profile.id},
                  ${values.purpose ?? "login"}, ${values.expiresAt ?? sql`now() + interval '1 hour'`},
                  ${values.usedAt ?? null})`.execute(schema.db);
    await expect(insert({ purpose: "admin" })).rejects.toMatchObject({
      constraint: "access_tokens_purpose_check",
    });
    await expect(insert({ hash: "nie-hash" })).rejects.toMatchObject({
      constraint: "access_tokens_token_hash_check",
    });
    await expect(insert({ expiresAt: sql`now() + interval '8 days'` })).rejects.toMatchObject({
      constraint: "access_tokens_expiry_check",
    });
    await expect(insert({ expiresAt: sql`now() - interval '1 hour'` })).rejects.toMatchObject({
      constraint: "access_tokens_expiry_check",
    });
    await expect(
      insert({ purpose: "unsubscribe", expiresAt: sql`now() + interval '61 days'` }),
    ).rejects.toMatchObject({ constraint: "access_tokens_expiry_check" });
    await expect(insert({ purpose: "unsubscribe", usedAt: sql`now()` })).rejects.toMatchObject({
      constraint: "access_tokens_used_at_check",
    });
    const hash = hashSecretToken(newSecretToken());
    await insert({ hash });
    await expect(insert({ hash })).rejects.toMatchObject({
      constraint: "access_tokens_token_hash_key",
    });
    await expect(
      sql`INSERT INTO sessions (token_hash, profile_id, expires_at)
          VALUES (${hashSecretToken(newSecretToken())}, ${profile.id},
                  now() + interval '31 days')`.execute(schema.db),
    ).rejects.toMatchObject({ constraint: "sessions_expiry_check" });
  });

  it("access:link prints a working single-use link", async () => {
    let stdout = "";
    let stderr = "";
    const code = await runCli(
      ["access:link", profile.id],
      {
        env: { NODE_ENV: "test", DATABASE_URL: schema.url, PUBLIC_BASE_URL: BASE },
        stdout: (text) => (stdout += text),
        stderr: (text) => (stderr += text),
      },
      defaultCliDeps,
    );
    expect(code).toBe(ExitCode.Ok);
    const printed = JSON.parse(stdout) as { url: string; expiresAt: string };
    expect(printed.url).toMatch(new RegExp(`^${BASE}/dostep/[A-Za-z0-9_-]{43}$`));
    const token = printed.url.slice(`${BASE}/dostep/`.length);
    expect(stderr).not.toContain(token);
    const expiresIn = new Date(printed.expiresAt).getTime() - Date.now();
    expect(expiresIn).toBeGreaterThan(7 * 24 * 3600 * 1000 - 60_000);
    expect(expiresIn).toBeLessThanOrEqual(7 * 24 * 3600 * 1000);
    expect((await fetch(`${url}/dostep/${token}`)).status).toBe(200);
    expect((await post("/dostep", `token=${token}`, { origin: BASE })).status).toBe(303);

    let missingErr = "";
    const missing = await runCli(
      ["access:link", "00000000-0000-4000-8000-0000000000ff"],
      {
        env: { NODE_ENV: "test", DATABASE_URL: schema.url, PUBLIC_BASE_URL: BASE },
        stdout: () => undefined,
        stderr: (text) => (missingErr += text),
      },
      defaultCliDeps,
    );
    expect(missing).toBe(ExitCode.Failure);
    expect(missingErr).toBe("Profile not found.\n");
  });

  describe("access:revoke", () => {
    async function revoke(profileId: string) {
      let stdout = "";
      let stderr = "";
      const code = await runCli(
        ["access:revoke", profileId],
        {
          // No PUBLIC_BASE_URL: revoking builds no links.
          env: { NODE_ENV: "test", DATABASE_URL: schema.url },
          stdout: (text) => (stdout += text),
          stderr: (text) => (stderr += text),
        },
        defaultCliDeps,
      );
      return { code, stdout, stderr };
    }

    async function rowCounts(profileId: string) {
      const tokens = await schema.db
        .selectFrom("access_tokens")
        .select("id")
        .where("profile_id", "=", profileId)
        .execute();
      const sessions = await schema.db
        .selectFrom("sessions")
        .select("id")
        .where("profile_id", "=", profileId)
        .execute();
      return { tokens: tokens.length, sessions: sessions.length };
    }

    it("ends every link and session of the profile at once and nothing else", async () => {
      // This profile: two sessions (their login tokens are used up), one unused
      // login link and one unsubscribe link.
      const first = await login();
      const second = await login();
      const loginLink = await issueAccessToken(schema.db, profile.id, "login");
      const unsubscribeLink = await issueAccessToken(schema.db, profile.id, "unsubscribe");
      // Another profile, whose access must survive (tenant isolation).
      const other = await createCompanyProfile(schema.db, {
        ...profileInput,
        email: "biuro@example.invalid",
        name: "Anna Nowak",
      });
      const otherLogin = await issueAccessToken(schema.db, other.id, "login");
      const otherSession = await consumeLoginToken(
        schema.db,
        (await issueAccessToken(schema.db, other.id, "login")).token,
      );
      const otherUnsubscribe = await issueAccessToken(schema.db, other.id, "unsubscribe");
      expect(otherSession).not.toBeNull();
      const otherCookie = `${SESSION_COOKIE}=${otherSession?.sessionToken ?? ""}`;
      const otherBefore = await rowCounts(other.id);
      expect(otherBefore).toEqual({ tokens: 3, sessions: 1 });
      const profileBefore = await schema.db
        .selectFrom("company_profiles")
        .select(["active", "updated_at"])
        .where("id", "=", profile.id)
        .executeTakeFirstOrThrow();

      const result = await revoke(profile.id);
      expect(result.code).toBe(ExitCode.Ok);
      expect(JSON.parse(result.stdout)).toEqual({ status: "ok", tokens: 4, sessions: 2 });
      expect(result.stderr).toBe("");
      for (const secret of [first.token, second.token, loginLink.token, unsubscribeLink.token]) {
        expect(result.stdout).not.toContain(secret);
        expect(result.stdout).not.toContain(hashSecretToken(secret));
      }
      expect(result.stdout).not.toContain(EMAIL);
      expect(await rowCounts(profile.id)).toEqual({ tokens: 0, sessions: 0 });

      // Every link and browser of the profile stops working.
      const neutral = await invalidLinkBody();
      const loginPage = await fetch(`${url}/dostep/${loginLink.token}`);
      expect(loginPage.status).toBe(404);
      expect(await loginPage.text()).toBe(neutral);
      expect((await post("/dostep", `token=${loginLink.token}`, { origin: BASE })).status).toBe(
        404,
      );
      expect((await fetch(`${url}/wypis/${unsubscribeLink.token}`)).status).toBe(404);
      expect(
        (await post(`/wypis/${unsubscribeLink.token}`, "List-Unsubscribe=One-Click")).status,
      ).toBe(404);
      for (const { cookie } of [first, second]) {
        expect((await fetch(`${url}/profil`, { headers: { cookie } })).status).toBe(401);
      }
      // The profile itself is untouched: still active, same updated_at.
      expect(
        await schema.db
          .selectFrom("company_profiles")
          .select(["active", "updated_at"])
          .where("id", "=", profile.id)
          .executeTakeFirstOrThrow(),
      ).toEqual(profileBefore);

      // The other profile keeps its links and session.
      expect(await rowCounts(other.id)).toEqual(otherBefore);
      expect((await fetch(`${url}/dostep/${otherLogin.token}`)).status).toBe(200);
      expect((await fetch(`${url}/wypis/${otherUnsubscribe.token}`)).status).toBe(200);
      expect((await fetch(`${url}/profil`, { headers: { cookie: otherCookie } })).status).toBe(200);

      // Revoking again finds nothing to delete.
      const again = await revoke(profile.id);
      expect(again.code).toBe(ExitCode.Ok);
      expect(JSON.parse(again.stdout)).toEqual({ status: "ok", tokens: 0, sessions: 0 });
    });

    it("exits 1 for a profile that does not exist and deletes nothing", async () => {
      await login();
      await issueAccessToken(schema.db, profile.id, "unsubscribe");
      const result = await revoke("00000000-0000-4000-8000-0000000000ff");
      expect(result.code).toBe(ExitCode.Failure);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("Profile not found.\n");
      expect(await rowCounts(profile.id)).toEqual({ tokens: 2, sessions: 1 });
    });
  });
});
