import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defaultCliDeps, ExitCode, runCli } from "../../src/cli.js";
import type { CompanyProfile, CompanyProfileInput } from "../../src/domain/company-profile.js";
import type { OpportunityDraft } from "../../src/domain/opportunity.js";
import {
  hashSecretToken,
  issueAccessToken,
  revokeProfileAccess,
} from "../../src/infrastructure/db/access-repository.js";
import { createCompanyProfile } from "../../src/infrastructure/db/company-profiles-repository.js";
import { migrateToLatest } from "../../src/infrastructure/db/database.js";
import { countFeedback, rateOffer } from "../../src/infrastructure/db/feedback-repository.js";
import { upsertOpportunity } from "../../src/infrastructure/db/opportunities-repository.js";
import type {
  DeliveryStatus,
  DeliveryTransport,
  FeedbackVerdict,
} from "../../src/infrastructure/db/schema.js";
import { upsertSource } from "../../src/infrastructure/db/sources-repository.js";
import { createLogger } from "../../src/infrastructure/logger.js";
import { csrfTokenFor, SESSION_COOKIE } from "../../src/web/session.js";
import { MATCHES_SHOWN, startWebServer, type WebServer } from "../../src/web/server.js";
import { createTestSchema, skipWithoutDatabase, type TestSchema } from "./test-database.js";

/*
 * PR-12 with PostgreSQL (D-032): the rating links of the digest, the rating
 * buttons of /dopasowania, the CSV export and `feedback:report`, through a
 * real server on 127.0.0.1. Two customers (Jan Kowalski, Anna Nowak) check
 * that one never reads or rates through the other. Pseudonymised data only.
 */

const BASE = "https://radar.example.invalid";
const FORM = "application/x-www-form-urlencoded";
const DAY_MS = 24 * 60 * 60 * 1000;

const profileInput = (name: string, email: string) =>
  ({
    email,
    name,
    categories: ["elektryka"],
    includeKeywords: ["oświetlenie"],
    excludeKeywords: [],
    voivodeships: ["mazowieckie"],
    counties: [],
    active: true,
  }) satisfies CompanyProfileInput;

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
    deadline: new Date(Date.now() + 10 * DAY_MS + counter * 60_000),
    estimatedValue: null,
    currency: null,
    categories: ["45310000-3"],
    contact: null,
    fetchedAt: new Date(Date.now() - DAY_MS),
    fingerprint: `web-feedback-fp-${String(counter)}`,
    contentHash: "hash-1",
    status: "open",
    ...overrides,
  };
}

describe.skipIf(skipWithoutDatabase)("rating and export (PostgreSQL)", () => {
  let schema: TestSchema;
  let server: WebServer;
  let url = "";
  let jan: CompanyProfile;
  let anna: CompanyProfile;
  const logs: string[] = [];

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
      logger: createLogger("info", (line) => logs.push(line)),
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
    await sql`DELETE FROM deliveries`.execute(schema.db);
    await sql`DELETE FROM opportunities`.execute(schema.db);
    await sql`DELETE FROM company_profiles`.execute(schema.db);
    jan = await createCompanyProfile(
      schema.db,
      profileInput("Jan Kowalski Elektryka", "jan@example.invalid"),
    );
    anna = await createCompanyProfile(
      schema.db,
      profileInput("Anna Nowak Instalacje", "anna@example.invalid"),
    );
    logs.length = 0;
  });

  async function offer(overrides: Partial<OpportunityDraft> = {}): Promise<string> {
    const result = await upsertOpportunity(schema.db, draft(overrides));
    return result.opportunity.id;
  }

  async function deliver(
    profileId: string,
    opportunityId: string,
    status: DeliveryStatus,
    {
      transport = "test",
      sentAt = new Date(),
    }: { transport?: DeliveryTransport; sentAt?: Date } = {},
  ) {
    await schema.db
      .insertInto("deliveries")
      .values({
        profile_id: profileId,
        opportunity_id: opportunityId,
        transport,
        digest_date: "2026-11-02",
        status,
        attempts: 1,
        error_code: status === "failed" ? "smtp_transient" : null,
        sent_at: status === "sent" ? sentAt : null,
      })
      .execute();
  }

  async function feedbackToken(profileId: string): Promise<string> {
    return (await issueAccessToken(schema.db, profileId, "feedback")).token;
  }

  function ratingPath(token: string, opportunityId: string, word: string): string {
    return `/ocena/${token}/${opportunityId}/${word}`;
  }

  function post(path: string, body: string, headers: Record<string, string> = {}) {
    return fetch(`${url}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": FORM, origin: BASE, ...headers },
      body,
    });
  }

  async function login(profileId: string) {
    const issued = await issueAccessToken(schema.db, profileId, "login");
    const response = await post("/dostep", `token=${issued.token}`);
    expect(response.status).toBe(303);
    const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const token = cookie.slice(`${SESSION_COOKIE}=`.length);
    return { cookie, csrf: csrfTokenFor(token) };
  }

  async function ratings() {
    return schema.db
      .selectFrom("match_feedback")
      .select(["profile_id", "opportunity_id", "verdict"])
      .orderBy("profile_id")
      .orderBy("opportunity_id")
      .execute();
  }

  async function storedRating(profileId: string, opportunityId: string) {
    return schema.db
      .selectFrom("match_feedback")
      .select(["verdict", "created_at", "updated_at"])
      .where("profile_id", "=", profileId)
      .where("opportunity_id", "=", opportunityId)
      .executeTakeFirst();
  }

  /** Moves a rating's times back, so a later change of updated_at is visible. */
  async function backdate(profileId: string, opportunityId: string, at: Date) {
    await schema.db
      .updateTable("match_feedback")
      .set({ created_at: at, updated_at: at })
      .where("profile_id", "=", profileId)
      .where("opportunity_id", "=", opportunityId)
      .execute();
  }

  function expectTokenPageHeaders(response: Response) {
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin");
  }

  describe("rating link (/ocena/<token>/<offer>/<trafne|nietrafne>)", () => {
    it("GET and HEAD only show the confirmation; nothing is written (AC1)", async () => {
      const id = await offer({ title: "Modernizacja oświetlenia <szkoły>" });
      await deliver(jan.id, id, "sent");
      const token = await feedbackToken(jan.id);
      const path = ratingPath(token, id, "trafne");

      const page = await fetch(`${url}${path}`);
      expect(page.status).toBe(200);
      expectTokenPageHeaders(page);
      const html = await page.text();
      expect(html).toContain("Modernizacja oświetlenia &lt;szkoły&gt;");
      expect(html).toContain(`<form method="post" action="${path}">`);
      expect(html).toContain("Zapisz ocenę: trafne");

      const head = await fetch(`${url}${path}`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expectTokenPageHeaders(head);
      // Opened many times (a mail scanner): still nothing written, the link still works.
      await fetch(`${url}${ratingPath(token, id, "nietrafne")}`);
      expect(await ratings()).toEqual([]);
      expect((await fetch(`${url}${path}`)).status).toBe(200);
    });

    it("POST stores the rating; a repeat leaves one row (AC3); a change updates it", async () => {
      const id = await offer();
      await deliver(jan.id, id, "sent");
      const token = await feedbackToken(jan.id);

      const saved = await post(ratingPath(token, id, "trafne"), "");
      expect(saved.status).toBe(200);
      expectTokenPageHeaders(saved);
      expect(await saved.text()).toContain("Zapisaliśmy ocenę: trafne.");
      expect(await ratings()).toEqual([
        { profile_id: jan.id, opportunity_id: id, verdict: "relevant" },
      ]);

      const past = new Date(Date.now() - 3 * DAY_MS);
      await backdate(jan.id, id, past);
      // The same verdict again (the link is multi-use): one row, unchanged.
      expect((await post(ratingPath(token, id, "trafne"), "")).status).toBe(200);
      expect(await storedRating(jan.id, id)).toEqual({
        verdict: "relevant",
        created_at: past,
        updated_at: past,
      });

      // The other link of the same e-mail changes the verdict in place.
      expect((await post(ratingPath(token, id, "nietrafne"), "")).status).toBe(200);
      const changed = await storedRating(jan.id, id);
      expect(changed?.verdict).toBe("not_relevant");
      expect(changed?.created_at).toEqual(past);
      expect(changed?.updated_at.getTime()).toBeGreaterThan(past.getTime());
      expect(await ratings()).toHaveLength(1);

      // The confirmation page now shows the current rating.
      const html = await (await fetch(`${url}${ratingPath(token, id, "trafne")}`)).text();
      expect(html).toContain("Obecna ocena: nietrafne.");
    });

    it("offers only the other verdict when the link's one is already stored; GET writes nothing", async () => {
      const id = await offer();
      await deliver(jan.id, id, "sent");
      const token = await feedbackToken(jan.id);
      await rateOffer(schema.db, jan.id, id, "relevant");
      const page = await fetch(`${url}${ratingPath(token, id, "trafne")}`);
      expect(page.status).toBe(200);
      expectTokenPageHeaders(page);
      const html = await page.text();
      expect(html).toContain("<p>To zamówienie ma już ocenę: trafne.</p>");
      expect(html).toContain(
        `<form method="post" action="${ratingPath(token, id, "nietrafne")}">` +
          '<button type="submit">Zmień ocenę na: nietrafne</button></form>',
      );
      expect(html).not.toContain(`action="${ratingPath(token, id, "trafne")}"`);
      expect(await ratings()).toEqual([
        { profile_id: jan.id, opportunity_id: id, verdict: "relevant" },
      ]);
    });

    it("concurrent POSTs of both links leave exactly one row (AC3)", async () => {
      const id = await offer();
      await deliver(jan.id, id, "pending");
      const token = await feedbackToken(jan.id);
      const responses = await Promise.all(
        ["trafne", "nietrafne", "trafne", "nietrafne"].map((word) =>
          post(ratingPath(token, id, word), ""),
        ),
      );
      expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
      const rows = await ratings();
      expect(rows).toHaveLength(1);
      expect(["relevant", "not_relevant"]).toContain(rows[0]?.verdict);
    });

    it("gives one and the same 404 to every refused link, GET and POST, writing nothing (AC2)", async () => {
      const mine = await offer();
      const annas = await offer();
      const failed = await offer();
      const undelivered = await offer();
      await deliver(jan.id, mine, "sent");
      await deliver(anna.id, annas, "sent");
      await deliver(jan.id, failed, "failed");
      const token = await feedbackToken(jan.id);
      const expired = await feedbackToken(jan.id);
      await schema.db
        .updateTable("access_tokens")
        .set({
          created_at: sql<Date>`now() - interval '61 days'`,
          expires_at: sql<Date>`now() - interval '1 day'`,
        })
        .where("token_hash", "=", hashSecretToken(expired))
        .execute();
      const login = (await issueAccessToken(schema.db, jan.id, "login")).token;
      const unsubscribe = (await issueAccessToken(schema.db, jan.id, "unsubscribe")).token;
      // The valid link works.
      expect((await fetch(`${url}${ratingPath(token, mine, "trafne")}`)).status).toBe(200);

      const refused = [
        // Another customer's offer, with my valid token.
        ratingPath(token, annas, "trafne"),
        // An offer never e-mailed to me, or whose e-mail failed.
        ratingPath(token, undelivered, "trafne"),
        ratingPath(token, failed, "nietrafne"),
        ratingPath(token, "00000000-0000-4000-8000-000000000999", "trafne"),
        // Unknown, expired and other-purpose tokens.
        ratingPath("A".repeat(43), mine, "trafne"),
        ratingPath(expired, mine, "trafne"),
        ratingPath(login, mine, "trafne"),
        ratingPath(unsubscribe, mine, "trafne"),
        ratingPath("short", mine, "trafne"),
        // Bad verdicts, ids and shapes.
        ratingPath(token, mine, "TRAFNE"),
        ratingPath(token, mine, "relevant"),
        ratingPath(token, mine, "tak"),
        ratingPath(token, mine.toUpperCase(), "trafne"),
        ratingPath(token, "1' OR '1'='1", "trafne"),
        `${ratingPath(token, mine, "trafne")}/extra`,
        `/ocena/${token}/${mine}`,
        `/ocena/${token}`,
        `/ocena/${token}//trafne`,
      ];
      const reference = await fetch(`${url}${refused[0] ?? ""}`);
      expect(reference.status).toBe(404);
      const referenceBody = await reference.text();
      expect(referenceBody).toContain("Ten link nie działa.");
      // The route's hint, the same for every refused rating link.
      expect(referenceBody).toContain(
        "<p>Zamówienia ocenisz też na stronie „Pasujące zamówienia” po zalogowaniu.</p>",
      );
      for (const path of refused) {
        for (const method of ["GET", "POST"] as const) {
          const response = method === "GET" ? await fetch(`${url}${path}`) : await post(path, "");
          expect({ path, method, status: response.status }).toEqual({
            path,
            method,
            status: 404,
          });
          expectTokenPageHeaders(response);
          expect(await response.text()).toBe(referenceBody);
        }
      }
      expect(await ratings()).toEqual([]);
    });

    it("refuses a POST from a foreign origin or with a body, writing nothing", async () => {
      const id = await offer();
      await deliver(jan.id, id, "sent");
      const token = await feedbackToken(jan.id);
      const path = ratingPath(token, id, "trafne");
      const foreign = await post(path, "", { origin: "https://evil.example.invalid" });
      expect(foreign.status).toBe(403);
      expect((await post(path, "verdict=relevant")).status).toBe(400);
      expect(await ratings()).toEqual([]);
    });

    it("stops working once the customer's access is revoked", async () => {
      const id = await offer();
      await deliver(jan.id, id, "sent");
      const token = await feedbackToken(jan.id);
      await revokeProfileAccess(schema.db, jan.id);
      expect((await fetch(`${url}${ratingPath(token, id, "trafne")}`)).status).toBe(404);
      expect((await post(ratingPath(token, id, "trafne"), "")).status).toBe(404);
      expect(await ratings()).toEqual([]);
    });

    it("never logs the token or the offer's title", async () => {
      const id = await offer({ title: "Modernizacja oświetlenia w Przykładowie" });
      await deliver(jan.id, id, "sent");
      const token = await feedbackToken(jan.id);
      await fetch(`${url}${ratingPath(token, id, "trafne")}`);
      await post(ratingPath(token, id, "trafne"), "");
      await fetch(`${url}${ratingPath("A".repeat(43), id, "trafne")}`);
      expect(logs.length).toBeGreaterThan(0);
      const all = logs.join("\n");
      expect(all).not.toContain(token);
      expect(all).not.toContain("A".repeat(43));
      expect(all).not.toContain("Przykładowie");
    });
  });

  describe("/dopasowania rating buttons", () => {
    function rate(cookie: string, body: Record<string, string>) {
      return post("/dopasowania/ocena", new URLSearchParams(body).toString(), { cookie });
    }

    it("shows the buttons and rates with the session and CSRF, 303 back to the card", async () => {
      const id = await offer();
      const { cookie, csrf } = await login(jan.id);
      const before = await (await fetch(`${url}/dopasowania`, { headers: { cookie } })).text();
      expect(before).toContain(`<input type="hidden" name="csrf" value="${csrf}">`);
      expect(before).toContain(`<input type="hidden" name="oferta" value="${id}">`);
      expect(before).toContain('name="werdykt" value="trafne"');

      const response = await rate(cookie, { csrf, oferta: id, werdykt: "trafne" });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(`/dopasowania#oferta-${id}`);
      // Twice: one row; then changed.
      expect((await rate(cookie, { csrf, oferta: id, werdykt: "trafne" })).status).toBe(303);
      expect(await ratings()).toEqual([
        { profile_id: jan.id, opportunity_id: id, verdict: "relevant" },
      ]);
      expect((await rate(cookie, { csrf, oferta: id, werdykt: "nietrafne" })).status).toBe(303);
      expect(await ratings()).toEqual([
        { profile_id: jan.id, opportunity_id: id, verdict: "not_relevant" },
      ]);
      const after = await (await fetch(`${url}/dopasowania`, { headers: { cookie } })).text();
      expect(after).toContain("Twoja ocena: <strong>nietrafne</strong>");
    });

    it("after „Nietrafne” returns to the card that followed (`nastepna`), if well-formed", async () => {
      const first = await offer({ deadline: new Date(Date.now() + 2 * DAY_MS) });
      const second = await offer({ deadline: new Date(Date.now() + 3 * DAY_MS) });
      const { cookie, csrf } = await login(jan.id);
      const page = await (await fetch(`${url}/dopasowania`, { headers: { cookie } })).text();
      // The page names the card after each one; the last names none.
      expect(page).toContain(
        `<input type="hidden" name="oferta" value="${first}">` +
          `<input type="hidden" name="nastepna" value="${second}">`,
      );
      expect(page).not.toContain(`<input type="hidden" name="nastepna" value="${first}">`);

      // Valid: back to the next card; only the named offer is rated.
      const valid = await rate(cookie, {
        csrf,
        oferta: first,
        werdykt: "nietrafne",
        nastepna: second,
      });
      expect(valid.status).toBe(303);
      expect(valid.headers.get("location")).toBe(`/dopasowania#oferta-${second}`);
      expect(await ratings()).toEqual([
        { profile_id: jan.id, opportunity_id: first, verdict: "not_relevant" },
      ]);
      // „Trafne” keeps the rated card as the anchor.
      const relevant = await rate(cookie, {
        csrf,
        oferta: first,
        werdykt: "trafne",
        nastepna: second,
      });
      expect(relevant.headers.get("location")).toBe(`/dopasowania#oferta-${first}`);
      // Invalid or absent: rated as usual, back to the rated card.
      for (const nastepna of [second.toUpperCase(), "x", "", `${second}#x`, "/evil"]) {
        const response = await rate(cookie, {
          csrf,
          oferta: first,
          werdykt: "nietrafne",
          nastepna,
        });
        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toBe(`/dopasowania#oferta-${first}`);
      }
      const absent = await rate(cookie, { csrf, oferta: first, werdykt: "nietrafne" });
      expect(absent.headers.get("location")).toBe(`/dopasowania#oferta-${first}`);
      // Never decides what is rated: an offer the profile may not rate stays a 404.
      const annas = await offer({ location: { voivodeship: "opolskie" } });
      expect(
        (await rate(cookie, { csrf, oferta: annas, werdykt: "nietrafne", nastepna: second }))
          .status,
      ).toBe(404);
      expect(await ratings()).toEqual([
        { profile_id: jan.id, opportunity_id: first, verdict: "not_relevant" },
      ]);
      // A second `nastepna`: a malformed form, refused before anything else (the CSRF
      // field is not read from it), nothing written.
      expect(
        (
          await post(
            "/dopasowania/ocena",
            `csrf=${csrf}&oferta=${first}&werdykt=nietrafne&nastepna=${second}&nastepna=${second}`,
            { cookie },
          )
        ).status,
      ).toBe(403);
      expect(await ratings()).toEqual([
        { profile_id: jan.id, opportunity_id: first, verdict: "not_relevant" },
      ]);
    });

    it("refuses a missing or wrong CSRF token (403) and no session (401), writing nothing", async () => {
      const id = await offer();
      const { cookie, csrf } = await login(jan.id);
      expect((await rate(cookie, { oferta: id, werdykt: "trafne" })).status).toBe(403);
      const other = csrfTokenFor("B".repeat(43));
      expect((await rate(cookie, { csrf: other, oferta: id, werdykt: "trafne" })).status).toBe(403);
      expect((await rate("", { csrf, oferta: id, werdykt: "trafne" })).status).toBe(401);
      expect(
        (
          await post("/dopasowania/ocena", `csrf=${csrf}&oferta=${id}&werdykt=trafne`, {
            cookie,
            origin: "https://evil.example.invalid",
          })
        ).status,
      ).toBe(403);
      expect(await ratings()).toEqual([]);
    });

    it("refuses a bad verdict or id (400)", async () => {
      const id = await offer();
      const { cookie, csrf } = await login(jan.id);
      for (const body of [
        { csrf, oferta: id, werdykt: "relevant" },
        { csrf, oferta: id, werdykt: "" },
        { csrf, oferta: id.toUpperCase(), werdykt: "trafne" },
        { csrf, oferta: "x", werdykt: "trafne" },
        { csrf, oferta: id },
      ]) {
        expect((await rate(cookie, body)).status).toBe(400);
      }
      expect(await ratings()).toEqual([]);
    });

    it("rates only an offer matching the profile or sent to it; others are 404 (isolation)", async () => {
      // Anna's offer, in another region: it matches neither of them and was sent to Anna only.
      const annas = await offer({ location: { voivodeship: "opolskie" } });
      await deliver(anna.id, annas, "sent");
      const missing = "00000000-0000-4000-8000-000000000999";
      // Sent to Jan once, no longer matching: still his to rate.
      const sentToJan = await offer({ location: { voivodeship: "opolskie" } });
      await deliver(jan.id, sentToJan, "sent");
      const { cookie, csrf } = await login(jan.id);
      for (const oferta of [annas, missing]) {
        expect((await rate(cookie, { csrf, oferta, werdykt: "nietrafne" })).status).toBe(404);
      }
      expect(await ratings()).toEqual([]);
      expect((await rate(cookie, { csrf, oferta: sentToJan, werdykt: "trafne" })).status).toBe(303);
      expect(await ratings()).toEqual([
        { profile_id: jan.id, opportunity_id: sentToJan, verdict: "relevant" },
      ]);
    });

    it("greys „Nietrafne” offers and lists them last; another customer's ratings never show", async () => {
      const first = await offer({ deadline: new Date(Date.now() + 2 * DAY_MS) });
      const second = await offer({ deadline: new Date(Date.now() + 3 * DAY_MS) });
      const third = await offer({ deadline: new Date(Date.now() + 4 * DAY_MS) });
      await rateOffer(schema.db, jan.id, first, "not_relevant");
      await rateOffer(schema.db, jan.id, third, "relevant");
      await rateOffer(schema.db, anna.id, second, "not_relevant");

      const janPage = await (
        await fetch(`${url}/dopasowania`, { headers: { cookie: (await login(jan.id)).cookie } })
      ).text();
      const order = [...janPage.matchAll(/<li id="oferta-([0-9a-f-]{36})">/g)].map(
        (match) => match[1],
      );
      expect(order).toEqual([second, third, first]);
      expect(janPage).toContain(`<li id="oferta-${first}"><article class="nietrafne">`);
      expect(janPage).toContain(`<li id="oferta-${second}"><article><h2>`);
      expect(janPage.match(/class="nietrafne"/g)).toHaveLength(1);

      const annaPage = await (
        await fetch(`${url}/dopasowania`, { headers: { cookie: (await login(anna.id)).cookie } })
      ).text();
      const annaOrder = [...annaPage.matchAll(/<li id="oferta-([0-9a-f-]{36})">/g)].map(
        (match) => match[1],
      );
      expect(annaOrder).toEqual([first, third, second]);
      expect(annaPage).not.toContain("Twoja ocena: <strong>trafne</strong>");
      expect(annaPage).toContain(`<li id="oferta-${first}"><article><h2>`);
      expect(annaPage.match(/class="nietrafne"/g)).toHaveLength(1);
    });
  });

  describe("GET /dopasowania.csv", () => {
    it("requires a session", async () => {
      const response = await fetch(`${url}/dopasowania.csv`);
      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toMatch(/^text\/html/);
    });

    it("downloads the list: BOM, `;`, the header, formulas as text, empty missing values (AC4)", async () => {
      const formula = await offer({
        title: "=1+1 Modernizacja oświetlenia",
        issuerName: "Gmina; Przykładowa",
        deadline: new Date(Date.now() + 2 * DAY_MS),
      });
      const rated = await offer({ deadline: new Date(Date.now() + 3 * DAY_MS) });
      await rateOffer(schema.db, jan.id, formula, "not_relevant");
      await rateOffer(schema.db, jan.id, rated, "relevant");
      const { cookie } = await login(jan.id);
      const response = await fetch(`${url}/dopasowania.csv`, { headers: { cookie } });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
      expect(response.headers.get("content-disposition")).toMatch(
        /^attachment; filename="dopasowania-\d{4}-\d{2}-\d{2}\.csv"$/,
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const file = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
      const lines = file.slice(1).split("\r\n");
      expect(lines[0]).toBe(
        "Tytuł;Zamawiający;Termin składania ofert (czas polski);Data publikacji;" +
          "Wartość szacunkowa;Waluta;Lokalizacja;Kategorie;Kody CPV;Link;Źródło;Ocena",
      );
      // The order of the page: „Nietrafne” last.
      expect(lines[1]?.endsWith(";trafne")).toBe(true);
      const last = lines[2] ?? "";
      expect(last.startsWith('\'=1+1 Modernizacja oświetlenia;"Gmina; Przykładowa";')).toBe(true);
      expect(last.endsWith(";nietrafne")).toBe(true);
      // No value or currency in the source: empty cells, never 0.
      expect(last).toContain(";;;woj. mazowieckie;Elektryka;45310000-3;");
      expect(lines[3]).toBe("");
      expect(lines).toHaveLength(4);
    });

    it(`has the page's limit of ${String(MATCHES_SHOWN)} rows`, async () => {
      for (let i = 0; i < MATCHES_SHOWN + 3; i++) await offer();
      const { cookie } = await login(jan.id);
      const file = await (await fetch(`${url}/dopasowania.csv`, { headers: { cookie } })).text();
      // Header, the rows, and the empty string after the last CRLF.
      expect(file.split("\r\n")).toHaveLength(MATCHES_SHOWN + 2);
    });

    it("shows a customer only their own list and ratings", async () => {
      const id = await offer();
      await rateOffer(schema.db, anna.id, id, "not_relevant");
      const { cookie } = await login(jan.id);
      const file = await (await fetch(`${url}/dopasowania.csv`, { headers: { cookie } })).text();
      const [, row] = file.split("\r\n");
      expect(row?.endsWith(";")).toBe(true);
      expect(file).not.toContain("nietrafne");
    });
  });

  describe("match_feedback", () => {
    it("is deleted with its profile or its offer, and accepts only the two verdicts", async () => {
      const one = await offer();
      const two = await offer();
      await rateOffer(schema.db, jan.id, one, "relevant");
      await rateOffer(schema.db, anna.id, one, "relevant");
      await rateOffer(schema.db, anna.id, two, "not_relevant");
      await schema.db.deleteFrom("opportunities").where("id", "=", one).execute();
      expect(await ratings()).toEqual([
        { profile_id: anna.id, opportunity_id: two, verdict: "not_relevant" },
      ]);
      await schema.db.deleteFrom("company_profiles").where("id", "=", anna.id).execute();
      expect(await ratings()).toEqual([]);
      await expect(rateOffer(schema.db, jan.id, two, "maybe" as FeedbackVerdict)).rejects.toThrow(
        /match_feedback_verdict_check/,
      );
    });
  });

  describe("feedback:report", () => {
    async function report(args: string[] = []) {
      let stdout = "";
      let stderr = "";
      const code = await runCli(
        ["feedback:report", ...args],
        {
          env: { NODE_ENV: "test", DATABASE_URL: schema.url },
          stdout: (text) => (stdout += text),
          stderr: (text) => (stderr += text),
        },
        defaultCliDeps,
      );
      return { code, stdout, stderr };
    }

    it("reports a null precision (never 0) without any rating", async () => {
      const result = await report();
      expect(result.code).toBe(ExitCode.Ok);
      expect(JSON.parse(result.stdout)).toEqual({
        status: "ok",
        since: null,
        total: {
          ratings: 0,
          relevant: 0,
          notRelevant: 0,
          precision: null,
          delivered: 0,
          ratedDelivered: 0,
          coverage: null,
        },
        profiles: [],
        categories: [],
      });
    });

    it("counts per profile and category, from --since on (Poland's day), with ids only", async () => {
      const lights = await offer({ title: "Modernizacja oświetlenia w Przykładowie" });
      const cleaning = await offer({ categories: ["90910000-9"] });
      const old = await offer();
      await rateOffer(schema.db, jan.id, lights, "relevant");
      await rateOffer(schema.db, jan.id, cleaning, "not_relevant");
      await rateOffer(schema.db, anna.id, lights, "relevant");
      await rateOffer(schema.db, anna.id, old, "not_relevant");
      // 22:30 UTC is 23:30 on 31 January in Poland, before --since; 23:30 UTC is 1 February.
      await backdate(anna.id, old, new Date("2020-01-31T22:30:00.000Z"));
      await backdate(jan.id, cleaning, new Date("2020-01-31T23:30:00.000Z"));

      const [first, second] = [jan.id, anna.id].sort();
      const all = await report();
      expect(all.code).toBe(ExitCode.Ok);
      const parsed: unknown = JSON.parse(all.stdout);
      expect(parsed).toEqual({
        status: "ok",
        since: null,
        total: {
          ratings: 4,
          relevant: 2,
          notRelevant: 2,
          precision: 0.5,
          delivered: 0,
          ratedDelivered: 0,
          coverage: null,
        },
        profiles: [first, second].map((profileId) => ({
          profileId,
          ratings: 2,
          relevant: 1,
          notRelevant: 1,
          precision: 0.5,
          delivered: 0,
          ratedDelivered: 0,
          coverage: null,
        })),
        categories: [
          { category: "elektryka", ratings: 3, relevant: 2, notRelevant: 1, precision: 0.667 },
          { category: "sprzatanie", ratings: 1, relevant: 0, notRelevant: 1, precision: 0 },
        ],
      });
      expect(all.stdout).not.toContain("Przykładowie");
      expect(all.stdout).not.toContain("@example.invalid");

      const since = await report(["--since", "2020-02-01"]);
      expect(since.code).toBe(ExitCode.Ok);
      expect(JSON.parse(since.stdout)).toMatchObject({
        since: "2020-02-01",
        total: { ratings: 3, relevant: 2, notRelevant: 1, precision: 0.667 },
        profiles: [
          { profileId: jan.id, ratings: 2, relevant: 1, notRelevant: 1 },
          { profileId: anna.id, ratings: 1, relevant: 1, notRelevant: 0, precision: 1 },
        ].sort((a, b) => a.profileId.localeCompare(b.profileId)),
      });
      // countFeedback agrees with the command.
      expect((await countFeedback(schema.db, "2020-02-02")).profiles).toHaveLength(2);
      expect(await countFeedback(schema.db, "2099-01-01")).toEqual({
        profiles: [],
        offers: [],
        deliveries: [],
      });
    });

    it("reports coverage: offers sent once each, from --since on (Poland's day), per profile only", async () => {
      const twice = await offer();
      const early = await offer();
      const pending = await offer();
      const failed = await offer();
      const annas = await offer();
      // Sent over both transports (the unique key allows it): one offer delivered.
      // 23:30 UTC on 31 January is 1 February in Poland, from --since on.
      const firstOfFebruary = new Date("2020-01-31T23:30:00.000Z");
      await deliver(jan.id, twice, "sent", { sentAt: firstOfFebruary });
      await deliver(jan.id, twice, "sent", { transport: "smtp", sentAt: firstOfFebruary });
      // 22:30 UTC is 23:30 on 31 January in Poland, before --since.
      await deliver(jan.id, early, "sent", { sentAt: new Date("2020-01-31T22:30:00.000Z") });
      // Claimed or failed: never received, so not delivered — even when rated on the web.
      await deliver(jan.id, pending, "pending");
      await deliver(jan.id, failed, "failed");
      await deliver(anna.id, annas, "sent");
      await rateOffer(schema.db, jan.id, twice, "relevant");
      await rateOffer(schema.db, jan.id, pending, "relevant");
      await rateOffer(schema.db, jan.id, failed, "not_relevant");
      // Another profile's ratings never cover an offer sent to this one.
      await rateOffer(schema.db, jan.id, annas, "relevant");
      await rateOffer(schema.db, anna.id, early, "not_relevant");

      const byId = <T extends { profileId: string }>(rows: T[]) =>
        rows.sort((a, b) => a.profileId.localeCompare(b.profileId));
      const all = await report();
      expect(all.code).toBe(ExitCode.Ok);
      expect(JSON.parse(all.stdout)).toMatchObject({
        total: {
          ratings: 5,
          relevant: 3,
          notRelevant: 2,
          precision: 0.6,
          delivered: 3,
          ratedDelivered: 1,
          coverage: 0.333,
        },
        profiles: byId([
          {
            profileId: jan.id,
            ratings: 4,
            relevant: 3,
            notRelevant: 1,
            precision: 0.75,
            delivered: 2,
            ratedDelivered: 1,
            coverage: 0.5,
          },
          {
            profileId: anna.id,
            ratings: 1,
            relevant: 0,
            notRelevant: 1,
            precision: 0,
            delivered: 1,
            ratedDelivered: 0,
            coverage: 0,
          },
        ]),
      });

      const since = await report(["--since", "2020-02-01"]);
      expect(since.code).toBe(ExitCode.Ok);
      expect(JSON.parse(since.stdout)).toMatchObject({
        since: "2020-02-01",
        total: { delivered: 2, ratedDelivered: 1, coverage: 0.5 },
        profiles: byId([
          { profileId: jan.id, delivered: 1, ratedDelivered: 1, coverage: 1 },
          { profileId: anna.id, delivered: 1, ratedDelivered: 0, coverage: 0 },
        ]),
      });

      // A profile that only has offers sent is listed by countFeedback too.
      await sql`DELETE FROM match_feedback`.execute(schema.db);
      expect(await countFeedback(schema.db, null)).toEqual({
        profiles: [],
        offers: [],
        deliveries: byId([
          { profileId: jan.id, delivered: 2, ratedDelivered: 0 },
          { profileId: anna.id, delivered: 1, ratedDelivered: 0 },
        ]),
      });
      expect((await countFeedback(schema.db, "2099-01-01")).deliveries).toEqual([]);
    });

    it("refuses a bad --since (exit 2)", async () => {
      const result = await report(["--since", "2026-13-01"]);
      expect(result.code).toBe(ExitCode.Usage);
      expect(result.stderr).toContain("--since must be a calendar date YYYY-MM-DD.");
    });
  });
});
