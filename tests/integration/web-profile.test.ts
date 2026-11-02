import { setTimeout as delay } from "node:timers/promises";
import { sql, type Transaction } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CompanyProfile, CompanyProfileInput } from "../../src/domain/company-profile.js";
import type { OpportunityDraft } from "../../src/domain/opportunity.js";
import {
  consumeLoginToken,
  findSessionProfile,
  hashSecretToken,
  issueAccessToken,
  newSecretToken,
} from "../../src/infrastructure/db/access-repository.js";
import {
  createCompanyProfile,
  getCompanyProfile,
  updateProfileSettings,
} from "../../src/infrastructure/db/company-profiles-repository.js";
import { migrateToLatest } from "../../src/infrastructure/db/database.js";
import { upsertOpportunity } from "../../src/infrastructure/db/opportunities-repository.js";
import type { Database } from "../../src/infrastructure/db/schema.js";
import { upsertSource } from "../../src/infrastructure/db/sources-repository.js";
import { createLogger } from "../../src/infrastructure/logger.js";
import { csrfTokenFor, NOTICE_COOKIE, SESSION_COOKIE } from "../../src/web/session.js";
import {
  MATCHES_RETRY_AFTER_SECONDS,
  MATCHES_SHOWN,
  startWebServer,
  type WebServer,
} from "../../src/web/server.js";
import {
  createTestSchema,
  pausedTransaction,
  skipWithoutDatabase,
  waitUntilBlockedBy,
  type TestSchema,
} from "./test-database.js";

/*
 * PR-06B with PostgreSQL: the profile form, the e-mail change revocation,
 * the page of matches and re-enabling, through a real server on 127.0.0.1.
 * Pseudonymised data only; nothing leaves the machine.
 */

const BASE = "https://radar.example.invalid";
const FORM = "application/x-www-form-urlencoded";
const EMAIL = "kontakt@example.invalid";
const NEW_EMAIL = "biuro@example.invalid";
const DAY_MS = 24 * 60 * 60 * 1000;

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

/** What the profile form saves (no `active`), with the address changed. */
const newEmailSettings = {
  email: NEW_EMAIL,
  name: profileInput.name,
  categories: profileInput.categories,
  includeKeywords: profileInput.includeKeywords,
  excludeKeywords: profileInput.excludeKeywords,
  voivodeships: profileInput.voivodeships,
  counties: profileInput.counties,
};

/** The form as the settings page submits it; `extra` adds or replaces pairs. */
function settingsForm(csrf: string, overrides: Readonly<Record<string, string>> = {}): string {
  const single: Record<string, string> = {
    csrf,
    name: "Jan Kowalski Elektryka",
    email: EMAIL,
    email_confirm: "",
    counties: "warszawski zachodni",
    include_keywords: "oświetlenie\r\nlatarnie",
    exclude_keywords: "",
    ...overrides,
  };
  const params = new URLSearchParams(single);
  params.append("categories", "elektryka");
  params.append("categories", "it");
  params.append("voivodeships", "mazowieckie");
  return params.toString();
}

let counter = 0;
function draft(overrides: Partial<OpportunityDraft> = {}): OpportunityDraft {
  counter += 1;
  return {
    sourceId: "test-source",
    sourceUrl: `https://zamowienia.example.gov.pl/ogloszenie/${String(counter)}`,
    externalId: null,
    tenderId: null,
    issuerName: "Gmina Przykładowa",
    title: `Modernizacja oświetlenia ulicznego nr ${String(counter)}`,
    description: null,
    location: { voivodeship: "mazowieckie" },
    publishedAt: new Date(Date.now() - DAY_MS),
    deadline: new Date(Date.now() + 10 * DAY_MS),
    estimatedValue: null,
    currency: null,
    categories: ["45310000-3"],
    contact: null,
    fetchedAt: new Date(Date.now() - DAY_MS),
    fingerprint: `web-profile-fp-${String(counter)}`,
    contentHash: "hash-1",
    status: "open",
    ...overrides,
  };
}

describe.skipIf(skipWithoutDatabase)("customer pages (PostgreSQL)", () => {
  let schema: TestSchema;
  let server: WebServer;
  let url = "";
  let profile: CompanyProfile;

  beforeAll(async () => {
    schema = await createTestSchema();
    await migrateToLatest(schema.db);
    await upsertSource(schema.db, {
      id: "test-source",
      name: "Test source",
      baseUrl: "https://zamowienia.example.gov.pl",
      enabled: true,
    });
    server = await startWebServer({
      db: schema.db,
      publicBaseUrl: BASE,
      logger: createLogger("error", () => undefined),
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
    await sql`DELETE FROM opportunities`.execute(schema.db);
    await sql`DELETE FROM company_profiles`.execute(schema.db);
    profile = await createCompanyProfile(schema.db, profileInput);
  });

  function post(path: string, body: string, headers: Record<string, string> = {}) {
    return fetch(`${url}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": FORM, origin: BASE, ...headers },
      body,
    });
  }

  function cookiePair(response: Response): string {
    const header = response.headers.get("set-cookie") ?? "";
    return header.split(";")[0] ?? "";
  }

  async function login(profileId = profile.id) {
    const issued = await issueAccessToken(schema.db, profileId, "login");
    const response = await post("/dostep", `token=${issued.token}`);
    expect(response.status).toBe(303);
    const cookie = cookiePair(response);
    const token = cookie.slice(`${SESSION_COOKIE}=`.length);
    return { cookie, token, csrf: csrfTokenFor(token) };
  }

  async function stored(profileId = profile.id) {
    const row = await getCompanyProfile(schema.db, profileId);
    if (row === null) throw new Error("profile missing");
    return row;
  }

  describe("profile settings form", () => {
    it("shows the stored values to the signed-in profile only", async () => {
      const { cookie, token } = await login();
      const page = await fetch(`${url}/profil/ustawienia`, { headers: { cookie } });
      expect(page.status).toBe(200);
      expect(page.headers.get("cache-control")).toBe("no-store");
      const html = await page.text();
      expect(html).toContain('value="Jan Kowalski &lt;Elektryka&gt; &amp; syn"');
      expect(html).toContain(`name="email" value="${EMAIL}"`);
      expect(html).toContain('value="elektryka" checked>');
      expect(html).toContain(`name="csrf" value="${csrfTokenFor(token)}"`);
      expect(html).not.toContain(profile.id);
      expect(html).not.toContain(token);
    });

    it("saves a valid form: 303 to /profil, which says Zapisano once", async () => {
      const { cookie, csrf } = await login();
      const response = await post("/profil/ustawienia", settingsForm(csrf), { cookie });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/profil");
      const notice = response.headers.get("set-cookie") ?? "";
      expect(notice).toBe(
        `${NOTICE_COOKIE}=zapisano; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax`,
      );

      expect(await stored()).toMatchObject({
        name: "Jan Kowalski Elektryka",
        email: EMAIL,
        categories: ["elektryka", "it"],
        voivodeships: ["mazowieckie"],
        counties: ["warszawski zachodni"],
        includeKeywords: ["oświetlenie", "latarnie"],
        excludeKeywords: [],
        active: true,
      });

      const shown = await fetch(`${url}/profil`, {
        headers: { cookie: `${cookie}; ${cookiePair(response)}` },
      });
      expect(shown.status).toBe(200);
      expect(await shown.text()).toContain(
        '<p class="notice" role="status">Zapisano zmiany profilu.</p>',
      );
      expect(shown.headers.get("set-cookie")).toBe(
        `${NOTICE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
      );
      const again = await fetch(`${url}/profil`, { headers: { cookie } });
      expect(await again.text()).not.toContain('class="notice"');
      expect(again.headers.get("set-cookie")).toBeNull();
    });

    it("re-renders an invalid form as 400 with the submitted values, escaped, saving nothing", async () => {
      const { cookie, csrf } = await login();
      const before = await stored();
      const hostile = `<script>alert(1)</script>"`;
      const response = await post(
        "/profil/ustawienia",
        settingsForm(csrf, { name: hostile, include_keywords: `ok\n---\n${hostile}` }).replace(
          /&categories=[^&]+/g,
          "",
        ),
        { cookie },
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("<title>Błąd: Ustawienia profilu — Radar Zamówień</title>");
      expect(html).toContain('role="alert"');
      expect(html).toContain("Wybierz co najmniej jedną kategorię.");
      expect(html).toContain("Wiersz 2: wpis musi zawierać literę lub cyfrę.");
      expect(html).not.toContain("<script>");
      expect(html).toContain('value="&lt;script&gt;alert(1)&lt;/script&gt;&quot;"');
      expect(html).toContain("ok\n---\n&lt;script&gt;");
      expect(html).toContain(`name="csrf" value="${csrf}"`);
      expect(await stored()).toEqual(before);
    });

    it("refuses a control character (a pasted tab) with a Polish field error, saving nothing", async () => {
      const { cookie, csrf } = await login();
      const before = await stored();
      const response = await post(
        "/profil/ustawienia",
        settingsForm(csrf, {
          name: "Jan\tKowalski",
          include_keywords: "oświetlenie\r\nlatar\u0000nie",
        }),
        { cookie },
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain(
        "Nazwa firmy zawiera znaki sterujące (np. tabulator) — wpisz wartość ponownie.",
      );
      expect(html).toContain(
        "Wiersz 2: wpis zawiera znaki sterujące (np. tabulator) — wpisz wartość ponownie.",
      );
      expect(await stored()).toEqual(before);
    });

    it("refuses a missing or wrong CSRF token, a foreign Origin and a malformed form", async () => {
      const { cookie, csrf } = await login();
      const before = await stored();
      const other = csrfTokenFor((await login()).token);
      const changed = { name: "Zmieniona nazwa" };
      expect(
        (await post("/profil/ustawienia", settingsForm(other, changed), { cookie })).status,
      ).toBe(403);
      expect((await post("/profil/ustawienia", settingsForm("", changed), { cookie })).status).toBe(
        403,
      );
      expect(
        (
          await post("/profil/ustawienia", settingsForm(csrf, changed), {
            cookie,
            origin: "https://evil.example.invalid",
          })
        ).status,
      ).toBe(403);
      for (const body of [
        `${settingsForm(csrf, changed)}&name=x`,
        `${settingsForm(csrf, changed)}&active=false`,
        `csrf=${csrf}&name=x`,
      ]) {
        expect((await post("/profil/ustawienia", body, { cookie })).status).toBe(400);
      }
      expect((await post("/profil/ustawienia", settingsForm(csrf, changed))).status).toBe(401);
      expect(await stored()).toEqual(before);
    });

    it("checks the CSRF token before the form's own rules: no single csrf field is a 403", async () => {
      const { cookie, csrf } = await login();
      const before = await stored();
      const withoutCsrf = new URLSearchParams(settingsForm(csrf, { name: "Zmieniona nazwa" }));
      withoutCsrf.delete("csrf");
      const twice = new URLSearchParams(withoutCsrf);
      twice.append("csrf", csrf);
      twice.append("csrf", csrf);
      for (const body of [withoutCsrf.toString(), twice.toString(), "name=x", ""]) {
        expect((await post("/profil/ustawienia", body, { cookie })).status).toBe(403);
      }
      expect(await stored()).toEqual(before);
    });

    it("shows a duplicate address as a field error", async () => {
      await createCompanyProfile(schema.db, {
        ...profileInput,
        email: NEW_EMAIL,
        name: "Anna Nowak",
      });
      const { cookie, csrf } = await login();
      const response = await post(
        "/profil/ustawienia",
        settingsForm(csrf, { email: NEW_EMAIL, email_confirm: NEW_EMAIL }),
        { cookie },
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain(
        "Ten adres e-mail jest już przypisany do innego profilu. Jeśli to Twój drugi profil, " +
          "odpowiedz na ostatnią wiadomość.",
      );
      expect(html).toContain('aria-describedby="email-opis email-blad" aria-invalid="true"');
      expect(html).not.toContain("Anna Nowak");
      expect((await stored()).email).toBe(EMAIL);
    });

    it("refuses a county entry that is no county name, saving nothing", async () => {
      const { cookie, csrf } = await login();
      const before = await stored();
      const response = await post(
        "/profil/ustawienia",
        settingsForm(csrf, { counties: "warszawski zachodni\r\npowiat" }),
        { cookie },
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toContain(
        "Wiersz 2: wpisz nazwę powiatu, np. warszawski zachodni.",
      );
      expect(await stored()).toEqual(before);
    });

    it("needs the new address typed twice", async () => {
      const { cookie, csrf } = await login();
      const response = await post(
        "/profil/ustawienia",
        settingsForm(csrf, { email: NEW_EMAIL, email_confirm: "inny@example.invalid" }),
        { cookie },
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("Adresy e-mail różnią się.");
      expect((await stored()).email).toBe(EMAIL);
    });
  });

  describe("e-mail change", () => {
    async function accessRows(profileId: string) {
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

    it("revokes every link and every other session of the profile, and nothing else", async () => {
      const current = await login();
      const otherDevice = await login();
      const loginLink = await issueAccessToken(schema.db, profile.id, "login");
      const unsubscribeLink = await issueAccessToken(schema.db, profile.id, "unsubscribe");
      const other = await createCompanyProfile(schema.db, {
        ...profileInput,
        email: "inna@example.invalid",
        name: "Anna Nowak",
      });
      const otherSession = await consumeLoginToken(
        schema.db,
        (await issueAccessToken(schema.db, other.id, "login")).token,
      );
      const otherLink = await issueAccessToken(schema.db, other.id, "unsubscribe");
      const otherBefore = await accessRows(other.id);

      const response = await post(
        "/profil/ustawienia",
        settingsForm(current.csrf, {
          email: ` ${NEW_EMAIL.toUpperCase()}`,
          email_confirm: NEW_EMAIL,
        }),
        { cookie: current.cookie },
      );
      expect(response.status).toBe(303);
      expect(cookiePair(response)).toBe(`${NOTICE_COOKIE}=zmieniono_email`);
      expect((await stored()).email).toBe(NEW_EMAIL);
      // Only the session that made the change is left.
      expect(await accessRows(profile.id)).toEqual({ tokens: 0, sessions: 1 });

      // The other browser is signed out, the old links are dead.
      expect(
        (await fetch(`${url}/profil`, { headers: { cookie: otherDevice.cookie } })).status,
      ).toBe(401);
      expect((await fetch(`${url}/dostep/${loginLink.token}`)).status).toBe(404);
      expect((await post("/dostep", `token=${loginLink.token}`)).status).toBe(404);
      expect((await fetch(`${url}/wypis/${unsubscribeLink.token}`)).status).toBe(404);
      expect(
        (await post(`/wypis/${unsubscribeLink.token}`, "List-Unsubscribe=One-Click")).status,
      ).toBe(404);
      expect((await stored()).active).toBe(true);

      // The current browser still works, and says what happened.
      const page = await fetch(`${url}/profil`, {
        headers: { cookie: `${current.cookie}; ${cookiePair(response)}` },
      });
      expect(page.status).toBe(200);
      const changedHtml = await page.text();
      expect(changedHtml).toContain("Adres e-mail został zmieniony");
      expect(changedHtml).toContain("Sprawdź poniżej, czy nowy adres jest poprawny.");
      // The new address only; the old one is not shown anywhere.
      expect(changedHtml).toContain(`<p>Adres powiadomień: <strong>${NEW_EMAIL}</strong></p>`);
      expect(changedHtml).not.toContain(EMAIL);
      expect(
        (
          await post("/profil/ustawienia", settingsForm(current.csrf, { email: NEW_EMAIL }), {
            cookie: current.cookie,
          })
        ).status,
      ).toBe(303);

      // The other profile keeps everything.
      expect(await accessRows(other.id)).toEqual(otherBefore);
      expect(
        (
          await fetch(`${url}/profil`, {
            headers: { cookie: `${SESSION_COOKIE}=${otherSession?.sessionToken ?? ""}` },
          })
        ).status,
      ).toBe(200);
      expect((await fetch(`${url}/wypis/${otherLink.token}`)).status).toBe(200);
      expect((await stored(other.id)).email).toBe("inna@example.invalid");
    });

    it("revokes nothing when other fields change (the address only re-cased)", async () => {
      const current = await login();
      const otherDevice = await login();
      const loginLink = await issueAccessToken(schema.db, profile.id, "login");
      const unsubscribeLink = await issueAccessToken(schema.db, profile.id, "unsubscribe");
      const before = await accessRows(profile.id);
      expect(before).toEqual({ tokens: 4, sessions: 2 });

      const response = await post(
        "/profil/ustawienia",
        settingsForm(current.csrf, { email: EMAIL.toUpperCase(), name: "Nowa nazwa" }),
        { cookie: current.cookie },
      );
      expect(response.status).toBe(303);
      expect(cookiePair(response)).toBe(`${NOTICE_COOKIE}=zapisano`);
      expect(await stored()).toMatchObject({ name: "Nowa nazwa", email: EMAIL });
      expect(await accessRows(profile.id)).toEqual(before);
      expect(
        (await fetch(`${url}/profil`, { headers: { cookie: otherDevice.cookie } })).status,
      ).toBe(200);
      expect((await fetch(`${url}/dostep/${loginLink.token}`)).status).toBe(200);
      expect((await fetch(`${url}/wypis/${unsubscribeLink.token}`)).status).toBe(200);
    });

    describe("racing with other writers of the same profile", () => {
      /**
       * A login as consumeLoginToken runs it (token UPDATE, then session
       * INSERT, one transaction), paused after `pauseAfter` until resumed.
       */
      function pausedLogin(token: string, pauseAfter: "token" | "session") {
        const sessionToken = newSecretToken();
        let profileId = "";
        const useToken = async (trx: Transaction<Database>) => {
          const used = await trx
            .updateTable("access_tokens")
            .set({ used_at: sql<Date>`now()` })
            .where("token_hash", "=", hashSecretToken(token))
            .where("used_at", "is", null)
            .returning("profile_id")
            .executeTakeFirstOrThrow();
          profileId = used.profile_id;
        };
        const openSession = async (trx: Transaction<Database>) => {
          await trx
            .insertInto("sessions")
            .values({
              token_hash: hashSecretToken(sessionToken),
              profile_id: profileId,
              expires_at: sql<Date>`now() + interval '30 days'`,
            })
            .execute();
        };
        const paused =
          pauseAfter === "token"
            ? pausedTransaction(schema.db, useToken, openSession)
            : pausedTransaction(
                schema.db,
                async (trx) => {
                  await useToken(trx);
                  await openSession(trx);
                },
                () => Promise.resolve(),
              );
        return { ...paused, sessionToken };
      }

      async function deadlockTimeoutMs(): Promise<number> {
        const { rows } = await sql<{ ms: number }>`
          SELECT setting::int AS ms FROM pg_settings WHERE name = 'deadlock_timeout'
        `.execute(schema.db);
        return rows[0]?.ms ?? 1000;
      }

      // Before the fix the change locked the profile FOR UPDATE and changed the
      // address before deleting the tokens: a login holding its token row and
      // waiting for the profile's KEY SHARE closed a cycle (40P01, HTTP 500).
      it.each(["token", "session"] as const)(
        "does not deadlock with a login on the same profile (login paused after its %s)",
        async (pauseAfter) => {
          const current = await login();
          const link = await issueAccessToken(schema.db, profile.id, "login");
          const racing = pausedLogin(link.token, pauseAfter);
          const loginPid = await racing.pid;

          const change = updateProfileSettings(
            schema.db,
            profile.id,
            newEmailSettings,
            current.token,
          );
          // The change waits for the login's token row (it deletes the tokens).
          await waitUntilBlockedBy(schema.db, loginPid);
          racing.resume();
          // The login never waits for the change: it commits well before
          // PostgreSQL would even look for a deadlock, so the single retry on
          // 40P01 in updateProfileSettings cannot be what makes this pass.
          const limit = (await deadlockTimeoutMs()) / 2;
          const finished = await Promise.race([
            racing.done.then(() => "login committed"),
            delay(limit).then(() => "login still waiting"),
          ]);
          expect(finished).toBe("login committed");

          const saved = await change;
          expect(saved).toMatchObject({ emailChanged: true, profile: { email: NEW_EMAIL } });
          // The login committed first, so its session is revoked with the others.
          expect(await findSessionProfile(schema.db, racing.sessionToken)).toBeNull();
          expect(await findSessionProfile(schema.db, current.token)).toBe(profile.id);
          expect(await accessRows(profile.id)).toEqual({ tokens: 0, sessions: 1 });
        },
      );

      it("saves nothing when the session that sent the form has ended or expired", async () => {
        const ended = await login();
        const expired = await login();
        const link = await issueAccessToken(schema.db, profile.id, "login");
        await sql`DELETE FROM sessions WHERE token_hash = ${hashSecretToken(ended.token)}`.execute(
          schema.db,
        );
        await sql`
          UPDATE sessions
          SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day'
          WHERE token_hash = ${hashSecretToken(expired.token)}
        `.execute(schema.db);
        const before = await accessRows(profile.id);
        for (const session of [ended, expired]) {
          expect(
            await updateProfileSettings(schema.db, profile.id, newEmailSettings, session.token),
          ).toBeNull();
        }
        expect((await stored()).email).toBe(EMAIL);
        expect(await accessRows(profile.id)).toEqual(before);
        expect((await fetch(`${url}/dostep/${link.token}`)).status).toBe(200);
      });

      it("saves nothing when a logout of that session commits during the change", async () => {
        const current = await login();
        const otherDevice = await login();
        const logout = pausedTransaction(
          schema.db,
          async (trx) => {
            await trx
              .deleteFrom("sessions")
              .where("token_hash", "=", hashSecretToken(current.token))
              .execute();
          },
          () => Promise.resolve(),
        );
        const logoutPid = await logout.pid;
        const change = updateProfileSettings(
          schema.db,
          profile.id,
          newEmailSettings,
          current.token,
        );
        await waitUntilBlockedBy(schema.db, logoutPid);
        logout.resume();
        await logout.done;
        expect(await change).toBeNull();
        expect((await stored()).email).toBe(EMAIL);
        expect(await findSessionProfile(schema.db, otherDevice.token)).toBe(profile.id);
      });

      it("waits for an access:revoke, which locks the profile first as well", async () => {
        const current = await login();
        // The statements of revokeProfileAccess, paused between the two deletes.
        const revoke = pausedTransaction(
          schema.db,
          async (trx) => {
            await trx
              .selectFrom("company_profiles")
              .select("id")
              .where("id", "=", profile.id)
              .forNoKeyUpdate()
              .execute();
            await trx.deleteFrom("access_tokens").where("profile_id", "=", profile.id).execute();
          },
          async (trx) => {
            await trx.deleteFrom("sessions").where("profile_id", "=", profile.id).execute();
          },
        );
        const revokePid = await revoke.pid;
        const change = updateProfileSettings(
          schema.db,
          profile.id,
          newEmailSettings,
          current.token,
        );
        await waitUntilBlockedBy(schema.db, revokePid);
        revoke.resume();
        await revoke.done;
        // The revoke ended this session too: the change saves nothing.
        expect(await change).toBeNull();
        expect((await stored()).email).toBe(EMAIL);
        expect(await accessRows(profile.id)).toEqual({ tokens: 0, sessions: 0 });
      });

      it("answers 401 to the form of a session ended meanwhile, saving nothing", async () => {
        const { cookie, csrf, token } = await login();
        await sql`DELETE FROM sessions WHERE token_hash = ${hashSecretToken(token)}`.execute(
          schema.db,
        );
        const response = await post(
          "/profil/ustawienia",
          settingsForm(csrf, { email: NEW_EMAIL, email_confirm: NEW_EMAIL }),
          { cookie },
        );
        expect(response.status).toBe(401);
        expect((await stored()).email).toBe(EMAIL);
      });
    });
  });

  describe("matches page", () => {
    it("shows the matching offers, soonest deadline first, with their reasons", async () => {
      const later = await upsertOpportunity(
        schema.db,
        draft({ title: "Oświetlenie później", deadline: new Date(Date.now() + 9 * DAY_MS) }),
      );
      await upsertOpportunity(
        schema.db,
        draft({ title: "Oświetlenie wcześniej", deadline: new Date(Date.now() + 2 * DAY_MS) }),
      );
      // Not matching: another region; and one whose deadline has passed.
      await upsertOpportunity(
        schema.db,
        draft({ title: "Oświetlenie w Opolu", location: { voivodeship: "opolskie" } }),
      );
      await upsertOpportunity(
        schema.db,
        draft({ title: "Oświetlenie po terminie", deadline: new Date(Date.now() - DAY_MS) }),
      );
      const { cookie } = await login();
      const page = await fetch(`${url}/dopasowania`, { headers: { cookie } });
      expect(page.status).toBe(200);
      expect(page.headers.get("cache-control")).toBe("no-store");
      const html = await page.text();
      const titles = [...html.matchAll(/<h2>([^<]+)<\/h2>/g)].map((match) => match[1]);
      expect(titles).toEqual(["Oświetlenie wcześniej", "Oświetlenie później"]);
      expect(html).toContain("<dt>Dlaczego pasuje:</dt><dd>kategoria: elektryka (CPV 45310000-3)");
      expect(html).toContain(
        `<a href="${later.opportunity.sourceUrl}" rel="noopener noreferrer">` +
          "Otwórz ogłoszenie w źródle (zamowienia.example.gov.pl)</a>",
      );
      // Compact cards: one native disclosure per offer, holding the other fields.
      expect(html.match(/<details><summary>Szczegóły ogłoszenia<\/summary><dl>/g)).toHaveLength(2);
      expect(html).toContain(
        "<details><summary>Szczegóły ogłoszenia</summary><dl><dt>Data publikacji:",
      );
      // The place of work is visible, between the buyer and the deadline.
      expect(html).toContain(
        "<dt>Zamawiający:</dt><dd>Gmina Przykładowa</dd>" +
          "<dt>Lokalizacja:</dt><dd>woj. mazowieckie</dd><dt>Termin składania ofert:</dt>",
      );
      expect(html).not.toContain('class="note"');
    });

    it(`shows at most ${String(MATCHES_SHOWN)} and counts the rest`, async () => {
      for (let i = 0; i < MATCHES_SHOWN + 3; i++) {
        await upsertOpportunity(
          schema.db,
          draft({ deadline: new Date(Date.now() + (i + 1) * 60 * 60 * 1000) }),
        );
      }
      const { cookie } = await login();
      const html = await (await fetch(`${url}/dopasowania`, { headers: { cookie } })).text();
      expect(html.match(/<article>/g)).toHaveLength(MATCHES_SHOWN);
      expect(html).toContain("I 3 kolejne pasujące zamówienia z dalszym terminem.");
    });

    it("explains an empty list and notes an inactive profile", async () => {
      await sql`UPDATE company_profiles SET active = false`.execute(schema.db);
      const { cookie } = await login();
      const html = await (await fetch(`${url}/dopasowania`, { headers: { cookie } })).text();
      expect(html).toContain("Powiadomienia e-mail są wyłączone");
      expect(html).toContain("Brak pasujących zamówień.");
      expect(html).toContain("ostatnich 7 dni");
    });

    it("asks for a correction when the stored profile cannot be matched", async () => {
      await sql`UPDATE company_profiles SET include_keywords = ARRAY['---']`.execute(schema.db);
      const { cookie } = await login();
      const page = await fetch(`${url}/dopasowania`, { headers: { cookie } });
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Popraw go w");
      // The form still opens with the stored values, so it can be corrected.
      const form = await fetch(`${url}/profil/ustawienia`, { headers: { cookie } });
      expect(form.status).toBe(200);
      expect(await form.text()).toContain("\n---</textarea>");
    });

    it("matches each profile by its own preferences only", async () => {
      await upsertOpportunity(schema.db, draft({ title: "Oświetlenie dla elektryka" }));
      const other = await createCompanyProfile(schema.db, {
        ...profileInput,
        email: "inna@example.invalid",
        name: "Anna Nowak",
        categories: ["sprzatanie"],
        includeKeywords: [],
      });
      const { cookie } = await login(other.id);
      const html = await (await fetch(`${url}/dopasowania`, { headers: { cookie } })).text();
      expect(html).toContain("Brak pasujących zamówień.");
    });

    describe("one list at a time per process", () => {
      /** Holds the candidates' query of a /dopasowania request until released. */
      function lockOpportunities() {
        return pausedTransaction(
          schema.db,
          async (trx) => {
            await sql`LOCK TABLE opportunities IN ACCESS EXCLUSIVE MODE`.execute(trx);
          },
          () => Promise.resolve(),
        );
      }

      /** A server of its own with other slot limits; `lines` collects its log. */
      async function gatedServer(limits: {
        matchesMaxWaitMs?: number;
        matchesMaxWaiters?: number;
      }) {
        const lines: string[] = [];
        const gated = await startWebServer({
          db: schema.db,
          publicBaseUrl: BASE,
          logger: createLogger("info", (line) => lines.push(line)),
          host: "127.0.0.1",
          port: 0,
          cleanupIntervalMs: null,
          ...limits,
        });
        return { server: gated, url: `http://127.0.0.1:${String(gated.port)}`, lines };
      }

      /** Polls until `count` requests wait for the slot of `target`. */
      async function waitForWaiters(target: WebServer, count: number): Promise<void> {
        for (let attempt = 0; attempt < 250 && target.matchesWaiting !== count; attempt++) {
          await delay(20);
        }
        expect(target.matchesWaiting).toBe(count);
      }

      /** True when `promise` has not settled within `ms`. */
      async function stillPending(promise: Promise<unknown>, ms = 100): Promise<boolean> {
        const pending = Symbol("pending");
        const first = await Promise.race([
          promise.then(
            () => null,
            () => null,
          ),
          delay(ms, pending),
        ]);
        return first === pending;
      }

      it("lets a second request wait, then answers it; other pages meanwhile", async () => {
        await upsertOpportunity(schema.db, draft({ title: "Oświetlenie parku" }));
        const { cookie } = await login();
        const lock = lockOpportunities();
        const lockPid = await lock.pid;
        const first = fetch(`${url}/dopasowania`, { headers: { cookie } });
        await waitUntilBlockedBy(schema.db, lockPid);

        const second = fetch(`${url}/dopasowania`, { headers: { cookie } });
        await waitForWaiters(server, 1);
        expect(await stillPending(second)).toBe(true);
        expect((await fetch(`${url}/profil`, { headers: { cookie } })).status).toBe(200);
        expect((await fetch(`${url}/styl.css`)).status).toBe(200);

        lock.resume();
        await lock.done;
        for (const response of [await first, await second]) {
          expect(response.status).toBe(200);
          expect(await response.text()).toContain("Oświetlenie parku");
        }
        expect(server.matchesWaiting).toBe(0);
        expect((await fetch(`${url}/dopasowania`, { headers: { cookie } })).status).toBe(200);
      });

      it("answers at once with 503 and Retry-After when the queue is full", async () => {
        const gated = await gatedServer({ matchesMaxWaiters: 1 });
        try {
          const { cookie } = await login();
          const lock = lockOpportunities();
          const lockPid = await lock.pid;
          const first = fetch(`${gated.url}/dopasowania`, { headers: { cookie } });
          await waitUntilBlockedBy(schema.db, lockPid);
          const second = fetch(`${gated.url}/dopasowania`, { headers: { cookie } });
          await waitForWaiters(gated.server, 1);

          // Another session: the same one would get the per-session 429 first (D-028).
          const other = await login();
          const third = await fetch(`${gated.url}/dopasowania`, {
            headers: { cookie: other.cookie },
          });
          expect(third.status).toBe(503);
          expect(third.headers.get("retry-after")).toBe(String(MATCHES_RETRY_AFTER_SECONDS));
          expect(third.headers.get("cache-control")).toBe("no-store");
          expect(await third.text()).toContain(
            "Trwa przygotowanie listy dopasowań — spróbuj za kilka sekund.",
          );
          expect(await stillPending(second)).toBe(true);

          lock.resume();
          await lock.done;
          expect((await first).status).toBe(200);
          expect((await second).status).toBe(200);
        } finally {
          await gated.server.close();
        }
      });

      it("answers a third request of one session at once with 429, other sessions queue", async () => {
        await upsertOpportunity(schema.db, draft({ title: "Oświetlenie parku" }));
        const { cookie } = await login();
        const other = await login();
        const lock = lockOpportunities();
        const lockPid = await lock.pid;
        const first = fetch(`${url}/dopasowania`, { headers: { cookie } });
        await waitUntilBlockedBy(schema.db, lockPid);
        const second = fetch(`${url}/dopasowania`, { headers: { cookie } });
        await waitForWaiters(server, 1);
        expect(server.matchesSessions).toBe(1);

        const third = await fetch(`${url}/dopasowania`, { headers: { cookie } });
        expect(third.status).toBe(429);
        expect(third.headers.get("retry-after")).toBe(String(MATCHES_RETRY_AFTER_SECONDS));
        expect(third.headers.get("cache-control")).toBe("no-store");
        expect(await third.text()).toContain(
          "Lista dopasowań już się przygotowuje (np. w innej karcie albo po odświeżeniu strony) " +
            "— poczekaj kilka sekund i spróbuj ponownie.",
        );
        // Refused before the queue: the waiting request and the count are unchanged.
        expect(server.matchesWaiting).toBe(1);
        expect(await stillPending(second)).toBe(true);

        const fromOther = fetch(`${url}/dopasowania`, { headers: { cookie: other.cookie } });
        await waitForWaiters(server, 2);
        expect(server.matchesSessions).toBe(2);

        lock.resume();
        await lock.done;
        for (const response of [await first, await second, await fromOther]) {
          expect(response.status).toBe(200);
          expect(await response.text()).toContain("Oświetlenie parku");
        }
        // Every entry is gone once its requests ended; the session may ask again.
        expect(server.matchesSessions).toBe(0);
        expect((await fetch(`${url}/dopasowania`, { headers: { cookie } })).status).toBe(200);
        expect(server.matchesSessions).toBe(0);
      });

      it("frees a session's place when its request was refused with 503", async () => {
        const gated = await gatedServer({ matchesMaxWaitMs: 200 });
        try {
          const { cookie } = await login();
          const lock = lockOpportunities();
          const lockPid = await lock.pid;
          const first = fetch(`${gated.url}/dopasowania`, { headers: { cookie } });
          await waitUntilBlockedBy(schema.db, lockPid);
          // Two waits run out in turn: each frees its place, so no 429 follows.
          for (let round = 0; round < 2; round++) {
            const timedOut = await fetch(`${gated.url}/dopasowania`, { headers: { cookie } });
            expect(timedOut.status).toBe(503);
          }
          expect(gated.server.matchesSessions).toBe(1);
          lock.resume();
          await lock.done;
          expect((await first).status).toBe(200);
          expect(gated.server.matchesSessions).toBe(0);
        } finally {
          await gated.server.close();
        }
      });

      it("answers 503 with Retry-After when the wait runs out", async () => {
        const gated = await gatedServer({ matchesMaxWaitMs: 300 });
        try {
          const { cookie } = await login();
          const lock = lockOpportunities();
          const lockPid = await lock.pid;
          const first = fetch(`${gated.url}/dopasowania`, { headers: { cookie } });
          await waitUntilBlockedBy(schema.db, lockPid);

          const started = performance.now();
          const second = await fetch(`${gated.url}/dopasowania`, { headers: { cookie } });
          expect(performance.now() - started).toBeGreaterThanOrEqual(250);
          expect(second.status).toBe(503);
          expect(second.headers.get("retry-after")).toBe(String(MATCHES_RETRY_AFTER_SECONDS));
          expect(second.headers.get("cache-control")).toBe("no-store");
          expect(await second.text()).toContain("Trwa przygotowanie listy dopasowań");
          expect(gated.server.matchesWaiting).toBe(0);

          lock.resume();
          await lock.done;
          expect((await first).status).toBe(200);
        } finally {
          await gated.server.close();
        }
      });

      it("drops a waiter whose client hung up and serves the next one", async () => {
        const gated = await gatedServer({ matchesMaxWaiters: 1 });
        try {
          const { cookie } = await login();
          const lock = lockOpportunities();
          const lockPid = await lock.pid;
          const first = fetch(`${gated.url}/dopasowania`, { headers: { cookie } });
          await waitUntilBlockedBy(schema.db, lockPid);

          const abort = new AbortController();
          const leaving = fetch(`${gated.url}/dopasowania`, {
            headers: { cookie },
            signal: abort.signal,
          });
          await waitForWaiters(gated.server, 1);
          abort.abort();
          await expect(leaving).rejects.toThrow();
          // Its place is free again: the next request queues instead of a 503.
          await waitForWaiters(gated.server, 0);
          const next = fetch(`${gated.url}/dopasowania`, { headers: { cookie } });
          await waitForWaiters(gated.server, 1);

          lock.resume();
          await lock.done;
          expect((await first).status).toBe(200);
          expect((await next).status).toBe(200);
          const aborted = gated.lines.filter((line) => line.includes('"http request aborted"'));
          expect(aborted).toHaveLength(1);
          expect(aborted[0]).toContain('"route":"matches"');
        } finally {
          await gated.server.close();
        }
      });

      it("frees the slot after a failed computation", async () => {
        const { cookie } = await login();
        const lock = lockOpportunities();
        const lockPid = await lock.pid;
        const first = fetch(`${url}/dopasowania`, { headers: { cookie } });
        const blockedPid = await waitUntilBlockedBy(schema.db, lockPid);
        const waiting = fetch(`${url}/dopasowania`, { headers: { cookie } });
        await waitForWaiters(server, 1);
        await sql`SELECT pg_cancel_backend(${blockedPid}::int)`.execute(schema.db);
        expect((await first).status).toBe(500);
        // The failed holder handed the slot on: the waiter now computes.
        await waitForWaiters(server, 0);
        lock.resume();
        await lock.done;
        expect((await waiting).status).toBe(200);
        expect((await fetch(`${url}/dopasowania`, { headers: { cookie } })).status).toBe(200);
      });

      it("frees the slot after a client gave up waiting", async () => {
        const { cookie } = await login();
        const lock = lockOpportunities();
        const lockPid = await lock.pid;
        const abort = new AbortController();
        const first = fetch(`${url}/dopasowania`, { headers: { cookie }, signal: abort.signal });
        await waitUntilBlockedBy(schema.db, lockPid);
        abort.abort();
        await expect(first).rejects.toThrow();
        lock.resume();
        await lock.done;
        // The abandoned computation still finishes; then the slot is free again.
        let status = 0;
        for (let attempt = 0; attempt < 100 && status !== 200; attempt++) {
          if (attempt > 0) await delay(20);
          status = (await fetch(`${url}/dopasowania`, { headers: { cookie } })).status;
        }
        expect(status).toBe(200);
      });
    });
  });

  describe("re-enabling notifications", () => {
    it("is a CSRF-protected, idempotent POST from the profile page", async () => {
      await sql`UPDATE company_profiles SET active = false`.execute(schema.db);
      const { cookie, csrf } = await login();
      const page = await (await fetch(`${url}/profil`, { headers: { cookie } })).text();
      expect(page).toContain('<form method="post" action="/profil/wlacz">');

      expect((await post("/profil/wlacz", "csrf=x", { cookie })).status).toBe(403);
      expect((await post("/profil/wlacz", `csrf=${csrf}`, { cookie, origin: "null" })).status).toBe(
        403,
      );
      expect((await post("/profil/wlacz", `csrf=${csrf}`)).status).toBe(401);
      expect((await stored()).active).toBe(false);

      const first = await post("/profil/wlacz", `csrf=${csrf}`, { cookie });
      expect(first.status).toBe(303);
      expect(first.headers.get("location")).toBe("/profil");
      expect(cookiePair(first)).toBe(`${NOTICE_COOKIE}=wlaczono`);
      const enabled = await stored();
      expect(enabled.active).toBe(true);

      const second = await post("/profil/wlacz", `csrf=${csrf}`, { cookie });
      expect(second.status).toBe(303);
      // Idempotent: nothing changes, not even updated_at.
      expect(await stored()).toEqual(enabled);
    });
  });

  it("shows the current notification address on /profil, escaped", async () => {
    const { cookie } = await login();
    const html = await (await fetch(`${url}/profil`, { headers: { cookie } })).text();
    expect(html).toContain(`<p>Adres powiadomień: <strong>${EMAIL}</strong></p>`);

    // The database takes what the form would refuse; the page escapes it anyway.
    await sql`UPDATE company_profiles SET email = ${"o'brien&<syn>@example.invalid"}`.execute(
      schema.db,
    );
    const escaped = await (await fetch(`${url}/profil`, { headers: { cookie } })).text();
    expect(escaped).toContain(
      "<p>Adres powiadomień: <strong>o&#39;brien&amp;&lt;syn&gt;@example.invalid</strong></p>",
    );
    expect(escaped).not.toContain("<syn>");
  });

  it("names the company on the unsubscribe confirmation page", async () => {
    const issued = await issueAccessToken(schema.db, profile.id, "unsubscribe");
    const html = await (await fetch(`${url}/wypis/${issued.token}`)).text();
    expect(html).toContain(
      "<p>Firma: <strong>Jan Kowalski &lt;Elektryka&gt; &amp; syn</strong></p>",
    );
  });
});
