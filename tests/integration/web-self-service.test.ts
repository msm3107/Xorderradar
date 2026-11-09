import { setTimeout as delay } from "node:timers/promises";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CompanyProfile, CompanyProfileInput } from "../../src/domain/company-profile.js";
import {
  ACCESS_EMAILS_PER_DAY,
  issueAccessToken,
  requestLoginLink,
} from "../../src/infrastructure/db/access-repository.js";
import { createCompanyProfile } from "../../src/infrastructure/db/company-profiles-repository.js";
import { migrateToLatest } from "../../src/infrastructure/db/database.js";
import { createLogger } from "../../src/infrastructure/logger.js";
import {
  EMAIL_CHANGE_NOTICE_SUBJECT,
  EMAIL_CHANGE_SUBJECT,
  LOGIN_LINK_SUBJECT,
} from "../../src/notifications/access-emails.js";
import type { EmailSender, OutgoingEmail } from "../../src/notifications/sender.js";
import { LINK_REQUESTED_TEXT } from "../../src/web/pages.js";
import { startWebServer, type WebServer } from "../../src/web/server.js";
import { csrfTokenFor, NOTICE_COOKIE, SESSION_COOKIE } from "../../src/web/session.js";
import {
  createTestSchema,
  pausedTransaction,
  skipWithoutDatabase,
  type TestSchema,
} from "./test-database.js";

/*
 * PR-10 with PostgreSQL (D-031): „Wyślij mi link” and the confirmed e-mail
 * change, through a real server on 127.0.0.1 whose e-mails go to an
 * in-memory sender. The e-mails are sent after the response, so each test
 * waits for their log lines. Pseudonymised data only; nothing leaves the
 * machine.
 */

const BASE = "https://radar.example.invalid";
const FORM = "application/x-www-form-urlencoded";
const EMAIL = "kontakt@example.invalid";
const NEW_EMAIL = "biuro@example.invalid";
const INACTIVE_EMAIL = "wypisany@example.invalid";
const MISSING_EMAIL = "nieznany@example.invalid";
const TOKEN_IN_TEXT = /\/(?:dostep|potwierdz-email)\/([A-Za-z0-9_-]{43})/;

const profileInput = {
  email: EMAIL,
  name: "Jan Kowalski Elektryka",
  categories: ["elektryka"],
  includeKeywords: ["oświetlenie"],
  excludeKeywords: [],
  voivodeships: ["mazowieckie"],
  counties: [],
  active: true,
} satisfies CompanyProfileInput;

describe.skipIf(skipWithoutDatabase)("self-service access (PostgreSQL)", () => {
  let schema: TestSchema;
  let server: WebServer;
  let url = "";
  let profile: CompanyProfile;
  const mails: OutgoingEmail[] = [];
  const lines: string[] = [];
  /** Every secret the tests saw: none may appear in a log line. */
  const secrets = new Set<string>();
  const sender: EmailSender = {
    transport: "test",
    send(email) {
      mails.push(email);
      const token = TOKEN_IN_TEXT.exec(email.text)?.[1];
      if (token !== undefined) secrets.add(token);
      return Promise.resolve();
    },
    close() {},
  };

  beforeAll(async () => {
    schema = await createTestSchema();
    await migrateToLatest(schema.db);
    server = await startWebServer({
      db: schema.db,
      publicBaseUrl: BASE,
      logger: createLogger("debug", (line) => lines.push(line)),
      host: "127.0.0.1",
      port: 0,
      cleanupIntervalMs: null,
      sender,
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
    mails.length = 0;
  });

  /** Outcomes of the access e-mail jobs, in order; waits until `count` were logged. */
  async function accessOutcomes(count: number): Promise<string[]> {
    const outcomes = () =>
      lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry.message === "access mail")
        .map((entry) => `${String(entry.kind)}:${String(entry.outcome)}`);
    for (let waited = 0; outcomes().length < count; waited += 10) {
      if (waited > 5000) throw new Error(`only ${outcomes().join(", ")}`);
      await delay(10);
    }
    // Room for a wrong extra line to show up.
    await delay(30);
    return outcomes();
  }

  function post(path: string, body: string, headers: Record<string, string> = {}) {
    return fetch(`${url}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": FORM, origin: BASE, ...headers },
      body,
    });
  }

  let client = 0;
  /** „Wyślij mi link” from a new client address each time (the per-IP limit is tested apart). */
  function requestLink(email: string) {
    client += 1;
    return post("/wyslij-link", `email=${encodeURIComponent(email)}`, {
      "x-forwarded-for": `198.51.100.${String(client % 250)}`,
    });
  }

  function cookiePair(response: Response): string {
    return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  }

  async function login(profileId = profile.id) {
    const issued = await issueAccessToken(schema.db, profileId, "login");
    const response = await post("/dostep", `token=${issued.token}`);
    expect(response.status).toBe(303);
    const cookie = cookiePair(response);
    const token = cookie.slice(`${SESSION_COOKIE}=`.length);
    secrets.add(token);
    return { cookie, token, csrf: csrfTokenFor(token) };
  }

  /** The profile form with only the address changed, as the settings page submits it. */
  function settingsForm(csrf: string, email: string, name = profileInput.name): string {
    const params = new URLSearchParams({
      csrf,
      name,
      email,
      counties: "",
      include_keywords: "oświetlenie",
      exclude_keywords: "",
    });
    params.append("categories", "elektryka");
    params.append("voivodeships", "mazowieckie");
    return params.toString();
  }

  /** Saves a new address through the form; returns the confirmation token sent to it. */
  async function changeEmail(session: { cookie: string; csrf: string }, email = NEW_EMAIL) {
    const before = mails.length;
    const response = await post("/profil/ustawienia", settingsForm(session.csrf, email), {
      cookie: session.cookie,
    });
    expect(response.status).toBe(303);
    expect(cookiePair(response)).toBe(`${NOTICE_COOKIE}=wyslano_potwierdzenie`);
    for (let waited = 0; mails.length < before + 2; waited += 10) {
      if (waited > 5000) throw new Error("the change e-mails were not sent");
      await delay(10);
    }
    const confirmation = mails.slice(before).find((mail) => mail.to === email);
    const token = TOKEN_IN_TEXT.exec(confirmation?.text ?? "")?.[1];
    if (token === undefined) throw new Error("no confirmation link");
    return token;
  }

  async function row(profileId = profile.id) {
    return schema.db
      .selectFrom("company_profiles")
      .select(["email", "pending_email", "name", "updated_at"])
      .where("id", "=", profileId)
      .executeTakeFirstOrThrow();
  }

  async function accessRows(profileId = profile.id) {
    const tokens = await schema.db
      .selectFrom("access_tokens")
      .select(["purpose", "email"])
      .where("profile_id", "=", profileId)
      .orderBy("purpose")
      .execute();
    const sessions = await schema.db
      .selectFrom("sessions")
      .select("id")
      .where("profile_id", "=", profileId)
      .execute();
    return { tokens, sessions: sessions.length };
  }

  /**
   * Waits until `count` backends wait, directly or in a chain, for `pid`: the
   * second waiter for a row waits for the first one's tuple lock, not for `pid`.
   */
  async function blockedBy(pid: number, count: number): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt++) {
      const { rows } = await sql<{ blocked: number }>`
        WITH RECURSIVE waiting (pid) AS (
          SELECT ${pid}::int
          UNION
          SELECT activity.pid FROM pg_stat_activity AS activity
          JOIN waiting ON waiting.pid = ANY (pg_blocking_pids(activity.pid))
        )
        SELECT count(*)::int - 1 AS blocked FROM waiting
      `.execute(schema.db);
      if ((rows[0]?.blocked ?? 0) >= count) return;
      await delay(10);
    }
    throw new Error(`fewer than ${String(count)} backends blocked`);
  }

  /** Runs `race` while the profile row is held, letting it go even when `race` fails. */
  async function whileProfileHeld<T>(race: () => Promise<T>[]): Promise<T[]> {
    const held = holdProfileRow();
    const heldPid = await held.pid;
    let racing: Promise<T>[];
    try {
      racing = race();
      await blockedBy(heldPid, racing.length);
    } finally {
      held.resume();
      await held.done;
    }
    return Promise.all(racing);
  }

  /** Holds the profile row like any writer of its access does first (FOR NO KEY UPDATE). */
  function holdProfileRow(profileId = profile.id) {
    return pausedTransaction(
      schema.db,
      async (trx) => {
        await trx
          .selectFrom("company_profiles")
          .select("id")
          .where("id", "=", profileId)
          .forNoKeyUpdate()
          .execute();
      },
      () => Promise.resolve(),
    );
  }

  describe("„Wyślij mi link”", () => {
    it("answers an existing, a missing, an inactive and a limit-exhausted address identically", async () => {
      await createCompanyProfile(schema.db, {
        ...profileInput,
        email: INACTIVE_EMAIL,
        name: "Anna Nowak",
        active: false,
      });
      const exhausted = await createCompanyProfile(schema.db, {
        ...profileInput,
        email: "limit@example.invalid",
        name: "Piotr Wiśniewski",
      });
      for (let i = 0; i < ACCESS_EMAILS_PER_DAY; i++) {
        const issued = await requestLoginLink(schema.db, "limit@example.invalid");
        expect(issued).toMatchObject({ kind: "issued", profileId: exhausted.id });
      }
      lines.length = 0;

      const responses = [];
      for (const email of [EMAIL, MISSING_EMAIL, INACTIVE_EMAIL, "limit@example.invalid"]) {
        const response = await requestLink(email);
        const headers = [...response.headers].filter(([name]) => name !== "date");
        responses.push({ status: response.status, headers, body: await response.text() });
      }
      expect(responses[0]?.status).toBe(200);
      expect(responses[0]?.body).toContain(`<p>${LINK_REQUESTED_TEXT}</p>`);
      for (const response of responses.slice(1)) expect(response).toEqual(responses[0]);

      // After the responses: links for the existing and the inactive profile only.
      expect(await accessOutcomes(4)).toEqual([
        "login_link:sent",
        "login_link:no_profile",
        "login_link:sent",
        "login_link:limit_reached",
      ]);
      expect(mails.map((mail) => [mail.to, mail.subject])).toEqual([
        [EMAIL, LOGIN_LINK_SUBJECT],
        [INACTIVE_EMAIL, LOGIN_LINK_SUBJECT],
      ]);
    });

    it("sends a single-use 7-day login link to the profile's address; the 4th in 24 h nothing", async () => {
      lines.length = 0;
      for (const email of [EMAIL, ` ${EMAIL.toUpperCase()} `, EMAIL, EMAIL]) {
        expect((await requestLink(email)).status).toBe(200);
      }
      expect(await accessOutcomes(4)).toEqual([
        "login_link:sent",
        "login_link:sent",
        "login_link:sent",
        "login_link:limit_reached",
      ]);
      expect(mails).toHaveLength(ACCESS_EMAILS_PER_DAY);
      expect(ACCESS_EMAILS_PER_DAY).toBe(3);
      for (const mail of mails) expect(mail).toMatchObject({ to: EMAIL, listUnsubscribe: false });
      const { rows: tokens } = await sql<{ purpose: string; hours: number }>`
        SELECT purpose, extract(epoch FROM expires_at - created_at)::int / 3600 AS hours
        FROM access_tokens WHERE profile_id = ${profile.id}
      `.execute(schema.db);
      expect(tokens).toEqual(Array.from({ length: 3 }, () => ({ purpose: "login", hours: 168 })));
      const counted = await schema.db
        .selectFrom("access_emails")
        .select(["profile_id", "kind"])
        .execute();
      expect(counted).toEqual(
        Array.from({ length: 3 }, () => ({ profile_id: profile.id, kind: "login_link" })),
      );

      // The link signs in once, like every login link.
      const token = TOKEN_IN_TEXT.exec(mails[0]?.text ?? "")?.[1] ?? "";
      expect((await fetch(`${url}/dostep/${token}`)).status).toBe(200);
      expect((await post("/dostep", `token=${token}`)).status).toBe(303);
      expect((await post("/dostep", `token=${token}`)).status).toBe(404);
    });

    it("counts the limit atomically: after 2 links, 2 concurrent requests issue at most 1 more", async () => {
      for (let i = 0; i < 2; i++) {
        expect(await requestLoginLink(schema.db, EMAIL)).toMatchObject({ kind: "issued" });
      }
      // Both requests wait for the profile row, then run one after the other.
      const results = await whileProfileHeld(() => [
        requestLoginLink(schema.db, EMAIL),
        requestLoginLink(schema.db, EMAIL),
      ]);
      const kinds = results.map((result) => result.kind).sort();
      expect(kinds).toEqual(["issued", "limit_reached"]);
      const { tokens } = await accessRows();
      expect(tokens).toHaveLength(3);
      const { rows } = await sql<{ count: string }>`
        SELECT count(*) FROM access_emails WHERE profile_id = ${profile.id}
      `.execute(schema.db);
      expect(rows[0]?.count).toBe("3");
    });

    it("looks up the current address only, never a pending one", async () => {
      const session = await login();
      await changeEmail(session);
      lines.length = 0;
      mails.length = 0;
      await requestLink(NEW_EMAIL);
      await requestLink(EMAIL);
      expect(await accessOutcomes(2)).toEqual(["login_link:no_profile", "login_link:sent"]);
      expect(mails.map((mail) => mail.to)).toEqual([EMAIL]);
    });
  });

  describe("e-mail change with confirmation", () => {
    it("keeps the old address until the confirmation: logins and links use it", async () => {
      const session = await login();
      const loginLink = await issueAccessToken(schema.db, profile.id, "login");
      const token = await changeEmail(session);
      expect(await row()).toMatchObject({ email: EMAIL, pending_email: NEW_EMAIL });
      // The notice went to the old address, without a link or the new address.
      const notice = mails.find((mail) => mail.subject === EMAIL_CHANGE_NOTICE_SUBJECT);
      expect(notice?.to).toBe(EMAIL);
      expect(notice?.text).not.toMatch(/https?:|@/);
      expect(mails.find((mail) => mail.subject === EMAIL_CHANGE_SUBJECT)?.to).toBe(NEW_EMAIL);
      // Nothing revoked: the old link signs in, the session still works.
      expect((await post("/dostep", `token=${loginLink.token}`)).status).toBe(303);
      expect((await fetch(`${url}/profil`, { headers: { cookie: session.cookie } })).status).toBe(
        200,
      );
      expect((await accessRows()).tokens.filter((t) => t.purpose === "email_change")).toEqual([
        { purpose: "email_change", email: NEW_EMAIL },
      ]);

      // The confirmation from the signed-in browser: changed, this browser stays.
      const confirmed = await post(`/potwierdz-email/${token}`, "", { cookie: session.cookie });
      expect(confirmed.status).toBe(303);
      expect(cookiePair(confirmed)).toBe(`${NOTICE_COOKIE}=zmieniono_email`);
      expect(await row()).toMatchObject({ email: NEW_EMAIL, pending_email: null });
      expect(await accessRows()).toEqual({ tokens: [], sessions: 1 });
    });

    it("changes nothing on GET of the confirmation link (a mail scanner)", async () => {
      const session = await login();
      const token = await changeEmail(session);
      const before = { row: await row(), access: await accessRows() };
      for (const method of ["GET", "HEAD", "GET"]) {
        const response = await fetch(`${url}/potwierdz-email/${token}`, { method });
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        if (method === "GET") {
          const html = await response.text();
          expect(html).toContain(`<form method="post" action="/potwierdz-email/${token}">`);
          expect(html).not.toContain(NEW_EMAIL);
        }
      }
      expect({ row: await row(), access: await accessRows() }).toEqual(before);
    });

    it("confirms from a browser without the profile's session, signing every device out", async () => {
      const session = await login();
      const token = await changeEmail(session);
      const other = await createCompanyProfile(schema.db, {
        ...profileInput,
        email: "inna@example.invalid",
        name: "Anna Nowak",
      });
      const foreign = await login(other.id);
      const response = await post(`/potwierdz-email/${token}`, "", { cookie: foreign.cookie });
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.text()).toContain("Adres e-mail profilu został zmieniony");
      expect(await row()).toMatchObject({ email: NEW_EMAIL, pending_email: null });
      expect(await accessRows()).toEqual({ tokens: [], sessions: 0 });
      expect((await fetch(`${url}/profil`, { headers: { cookie: session.cookie } })).status).toBe(
        401,
      );
      // The other profile's session is not this profile's: untouched.
      expect((await fetch(`${url}/profil`, { headers: { cookie: foreign.cookie } })).status).toBe(
        200,
      );
    });

    it("changes the address once for concurrent confirmations; the other gets the invalid-link page", async () => {
      const session = await login();
      const token = await changeEmail(session);
      const responses = await whileProfileHeld(() => [
        post(`/potwierdz-email/${token}`, ""),
        post(`/potwierdz-email/${token}`, ""),
      ]);
      const statuses = responses.map((response) => response.status).sort();
      expect(statuses).toEqual([200, 404]);
      const loser = responses.find((response) => response.status === 404);
      const loserHtml = (await loser?.text()) ?? "";
      expect(loserHtml).toContain("Ten link nie działa.");
      // The confirmation route's sentence, though this token was valid a moment ago.
      expect(loserHtml).toContain("Link potwierdzający nowy adres?");
      expect(await row()).toMatchObject({ email: NEW_EMAIL, pending_email: null });
      // Used up: a later click is the invalid-link page too.
      expect((await post(`/potwierdz-email/${token}`, "")).status).toBe(404);
      expect((await fetch(`${url}/potwierdz-email/${token}`)).status).toBe(404);
    });

    it("answers a taken address with a neutral 409 and changes nothing", async () => {
      const session = await login();
      const token = await changeEmail(session);
      // Another profile took the address after the change was asked for.
      const other = await createCompanyProfile(schema.db, {
        ...profileInput,
        email: NEW_EMAIL,
        name: "Anna Nowak",
      });
      const before = { row: await row(), access: await accessRows() };
      const response = await post(`/potwierdz-email/${token}`, "", { cookie: session.cookie });
      expect(response.status).toBe(409);
      const html = await response.text();
      expect(html).toContain("adres e-mail profilu się nie zmienił");
      expect(html).not.toContain(NEW_EMAIL);
      expect(html).not.toContain("Anna Nowak");
      expect({ row: await row(), access: await accessRows() }).toEqual(before);
      expect((await row(other.id)).email).toBe(NEW_EMAIL);
    });

    it("cancels a pending change: the pending address and its link are gone", async () => {
      const session = await login();
      const token = await changeEmail(session);
      expect(
        (await post("/profil/anuluj-email", "csrf=x", { cookie: session.cookie })).status,
      ).toBe(403);
      expect((await row()).pending_email).toBe(NEW_EMAIL);
      for (let i = 0; i < 2; i++) {
        // Idempotent: a second click changes nothing more.
        const response = await post("/profil/anuluj-email", `csrf=${session.csrf}`, {
          cookie: session.cookie,
        });
        expect(response.status).toBe(303);
        expect(cookiePair(response)).toBe(`${NOTICE_COOKIE}=anulowano_zmiane`);
      }
      expect(await row()).toMatchObject({ email: EMAIL, pending_email: null });
      expect((await accessRows()).tokens.map((t) => t.purpose)).toEqual(["login"]);
      expect((await fetch(`${url}/potwierdz-email/${token}`)).status).toBe(404);
      expect((await post(`/potwierdz-email/${token}`, "")).status).toBe(404);
      expect((await row()).email).toBe(EMAIL);
      const page = await fetch(`${url}/profil`, {
        headers: { cookie: `${session.cookie}; ${NOTICE_COOKIE}=anulowano_zmiane` },
      });
      const html = await page.text();
      expect(html).toContain("Anulowano zmianę adresu e-mail.");
      expect(html).not.toContain("Oczekuje na potwierdzenie");
    });

    it("lets a new change replace the pending one: only the last link works", async () => {
      const session = await login();
      const first = await changeEmail(session);
      const second = await changeEmail(session, "drugi@example.invalid");
      expect((await row()).pending_email).toBe("drugi@example.invalid");
      expect((await fetch(`${url}/potwierdz-email/${first}`)).status).toBe(404);
      expect((await post(`/potwierdz-email/${first}`, "")).status).toBe(404);
      expect((await row()).email).toBe(EMAIL);
      expect((await post(`/potwierdz-email/${second}`, "")).status).toBe(200);
      expect((await row()).email).toBe("drugi@example.invalid");
    });

    it("refuses an expired confirmation link with the invalid-link page", async () => {
      const session = await login();
      const token = await changeEmail(session);
      await sql`
        UPDATE access_tokens
        SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day'
        WHERE purpose = 'email_change'
      `.execute(schema.db);
      expect((await fetch(`${url}/potwierdz-email/${token}`)).status).toBe(404);
      expect((await post(`/potwierdz-email/${token}`, "")).status).toBe(404);
      expect(await row()).toMatchObject({ email: EMAIL, pending_email: NEW_EMAIL });
    });

    it("says on the profile pages that the link expired, and pending again after a new one", async () => {
      const session = await login();
      await changeEmail(session);
      const pages = async () => {
        const headers = { cookie: session.cookie };
        const profilePage = await (await fetch(`${url}/profil`, { headers })).text();
        const settings = await (await fetch(`${url}/profil/ustawienia`, { headers })).text();
        return [profilePage, settings];
      };
      const pending = `Oczekuje na potwierdzenie: <strong>${NEW_EMAIL}</strong>`;
      const expired = `Link potwierdzający dla adresu <strong>${NEW_EMAIL}</strong> wygasł`;
      for (const html of await pages()) {
        expect(html).toContain(pending);
        expect(html).not.toContain("wygasł");
      }

      await sql`
        UPDATE access_tokens
        SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day'
        WHERE purpose = 'email_change'
      `.execute(schema.db);
      for (const html of await pages()) {
        expect(html).toContain(expired);
        expect(html).toContain("wpisz ten adres ponownie w ustawieniach profilu i zapisz");
        expect(html).not.toContain("Oczekuje na potwierdzenie");
        expect(html).toContain('<form method="post" action="/profil/anuluj-email">');
      }

      // Saving the address again sends a new link: pending again.
      await changeEmail(session);
      for (const html of await pages()) {
        expect(html).toContain(pending);
        expect(html).not.toContain("wygasł");
      }

      // A link that is gone (revoked) counts as expired too.
      await sql`DELETE FROM access_tokens WHERE purpose = 'email_change'`.execute(schema.db);
      for (const html of await pages()) expect(html).toContain(expired);
      expect(await row()).toMatchObject({ email: EMAIL, pending_email: NEW_EMAIL });
    });

    it("sends at most 3 confirmations in 24 hours, then shows a form error saving nothing", async () => {
      const session = await login();
      for (const email of ["a@example.invalid", "b@example.invalid", "c@example.invalid"]) {
        await changeEmail(session, email);
      }
      const sent = mails.length;
      const response = await post(
        "/profil/ustawienia",
        settingsForm(session.csrf, "d@example.invalid", "Nowa nazwa"),
        { cookie: session.cookie },
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("W ciągu doby wysłaliśmy już 3 linki potwierdzające zmianę adresu.");
      expect(html).toContain("Nie zapisaliśmy żadnej zmiany.");
      expect(html).toContain("Pozostałe zmiany zapiszesz teraz, wpisując z powrotem obecny adres.");
      expect(html).toContain('aria-describedby="email-opis email-blad" aria-invalid="true"');
      expect(await row()).toMatchObject({
        email: EMAIL,
        pending_email: "c@example.invalid",
        name: profileInput.name,
      });
      await delay(50);
      expect(mails).toHaveLength(sent);
      // An unchanged address still saves the other fields.
      const other = await post(
        "/profil/ustawienia",
        settingsForm(session.csrf, EMAIL, "Nowa nazwa"),
        { cookie: session.cookie },
      );
      expect(cookiePair(other)).toBe(`${NOTICE_COOKIE}=zapisano`);
      expect(await row()).toMatchObject({ name: "Nowa nazwa", pending_email: "c@example.invalid" });
    });
  });

  it("never logs an address, a token or a link", async () => {
    lines.length = 0;
    await requestLink(EMAIL);
    await requestLink(MISSING_EMAIL);
    await accessOutcomes(2);
    const session = await login();
    const token = await changeEmail(session);
    await post(`/potwierdz-email/${token}`, "", { cookie: session.cookie });
    await accessOutcomes(4);
    const logged = lines.join("");
    expect(secrets.size).toBeGreaterThan(2);
    for (const secret of [
      ...secrets,
      EMAIL,
      NEW_EMAIL,
      MISSING_EMAIL,
      "/dostep/",
      "potwierdz-email",
    ]) {
      expect(logged).not.toContain(secret);
    }
    expect(logged).not.toContain("198.51.100.");
  });
});
