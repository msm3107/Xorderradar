import { connect } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../src/infrastructure/db/database.js";
import { createLogger } from "../src/infrastructure/logger.js";
import {
  errorPage,
  homePage,
  invalidLinkPage,
  loginRequiredPage,
  profilePage,
  STYLESHEET,
  unsubscribedPage,
} from "../src/web/pages.js";
import { MAX_BODY_BYTES, parseForm, startWebServer, type WebServer } from "../src/web/server.js";

/*
 * The web server's request handling that needs no database: routing, method
 * and body checks, security headers. Database-backed flows (login, session,
 * CSRF, unsubscribe) are in tests/integration/web.test.ts. The pool points at
 * a closed port and is never used by these requests.
 */

const BASE = "https://radar.example.invalid";
const FORM = "application/x-www-form-urlencoded";

describe("parseForm", () => {
  const body = (text: string) => Buffer.from(text, "utf8");

  it("reads exactly the expected fields", () => {
    expect(parseForm(body("token=abc"), ["token"])).toEqual({ token: "abc" });
    expect(parseForm(body("a=1&b=%C5%BC+x"), ["a", "b"])).toEqual({ a: "1", b: "ż x" });
    expect(parseForm(body("List-Unsubscribe=One-Click"), ["List-Unsubscribe"])).toEqual({
      "List-Unsubscribe": "One-Click",
    });
  });

  it.each([
    ["", ["token"]],
    ["token=a&token=b", ["token"]],
    ["token=a&other=b", ["token"]],
    ["other=b", ["token"]],
    ["a=1", ["a", "b"]],
  ])("refuses %j for %j", (text, fields) => {
    expect(parseForm(body(text), fields)).toBeNull();
  });

  it("refuses invalid UTF-8", () => {
    expect(parseForm(Buffer.from([0x74, 0x3d, 0xff, 0xfe]), ["t"])).toBeNull();
  });
});

describe("pages", () => {
  it("are Polish, with no script and no inline style", () => {
    for (const page of [
      homePage(),
      errorPage(404),
      profilePage({ name: "X", active: true }, "c"),
    ]) {
      expect(page.html).toContain('<html lang="pl">');
      expect(page.html).not.toMatch(/<script|\sstyle=|<style|\son[a-z]+=/i);
      expect(page.html).toContain('<link rel="stylesheet" href="/styl.css">');
    }
  });

  it("escape the profile name and use real buttons in POST forms", () => {
    const page = profilePage({ name: `<img src=x onerror="alert(1)">&'`, active: true }, 'c&"');
    expect(page.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;");
    expect(page.html).not.toContain("<img");
    expect(page.html).toContain('value="c&amp;&quot;"');
    expect(page.html).toContain('<form method="post" action="/profil/wypisz">');
    expect(page.html).toContain('<form method="post" action="/wyloguj">');
    expect(page.html.match(/<button type="submit">/g)).toHaveLength(2);
  });

  it("offer no unsubscribe form for an inactive profile", () => {
    const page = profilePage({ name: "Jan Kowalski", active: false }, "c");
    expect(page.html).toContain("wyłączone");
    expect(page.html).not.toContain("/profil/wypisz");
    expect(page.html).toContain('action="/wyloguj"');
  });

  const newLinkHint =
    "Jeśli link został już użyty lub wygasł, odpowiedz na ostatnią wiadomość — operator wyśle nowy link.";
  const resubscribeHint =
    "Jeśli to pomyłka, odpowiedz na ostatnią wiadomość — włączymy powiadomienia ponownie.";

  it("tell the customer how to get a new link where a link is the way in", () => {
    const invalid = invalidLinkPage();
    expect(invalid.status).toBe(404);
    expect(invalid.html).toContain("Aktualny link znajdziesz w najnowszej wiadomości");
    const loginRequired = loginRequiredPage();
    expect(loginRequired.status).toBe(401);
    expect(loginRequired.html).toContain("Użyj linku „Twój profil” z ostatniej wiadomości");
    const home = homePage();
    expect(home.html).toContain("użyj linku „Twój profil” z ostatniej wiadomości");
    for (const page of [invalid, loginRequired, home]) {
      expect(page.html).toContain(`<p>${newLinkHint}</p>`);
      expect(page.html).not.toMatch(/<script|\sstyle=|<style|\son[a-z]+=/i);
    }
  });

  it("offer a way back after an unsubscribe", () => {
    const unsubscribed = unsubscribedPage();
    expect(unsubscribed.html).toContain("Powiadomienia e-mail zostały wyłączone");
    expect(unsubscribed.html).toContain(`<p>${resubscribeHint}</p>`);
    const inactive = profilePage({ name: "Jan Kowalski", active: false }, "c");
    expect(inactive.html).toContain(`<p>${resubscribeHint}</p>`);
    expect(profilePage({ name: "Jan Kowalski", active: true }, "c").html).not.toContain(
      resubscribeHint,
    );
  });
});

describe("web server without a session", () => {
  let server: WebServer;
  let url = "";
  const lines: string[] = [];
  const db = createDatabase("postgres://radar:not-a-real-password@127.0.0.1:1/radar");

  beforeAll(async () => {
    server = await startWebServer({
      db,
      publicBaseUrl: BASE,
      logger: createLogger("debug", (line) => lines.push(line)),
      host: "127.0.0.1",
      port: 0,
      cleanupIntervalMs: null,
    });
    url = `http://127.0.0.1:${String(server.port)}`;
  });
  afterAll(async () => {
    await server.close();
    await db.destroy();
  });

  function expectSecurityHeaders(response: Response, cache = "no-store") {
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; " +
        "base-uri 'none'",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe(cache);
  }

  it("serves the home page and the stylesheet with the security headers", async () => {
    const home = await fetch(`${url}/`);
    expect(home.status).toBe(200);
    expect(home.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expectSecurityHeaders(home);
    expect(await home.text()).toContain("Radar Zamówień");

    const css = await fetch(`${url}/styl.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expectSecurityHeaders(css, "public, max-age=3600");
    expect(await css.text()).toBe(STYLESHEET);

    const head = await fetch(`${url}/`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it.each(["/nie-ma", "/profil/", "/dostep/a/b", "/wypis", "/styl.css/x", "//", "/PROFIL"])(
    "answers 404 for %j",
    async (path) => {
      const response = await fetch(`${url}${path}`);
      expect(response.status).toBe(404);
      expectSecurityHeaders(response);
    },
  );

  it.each([
    ["POST", "/", "GET, HEAD"],
    ["PUT", "/profil", "GET, HEAD"],
    ["DELETE", "/wypis/x", "GET, HEAD, POST"],
    ["GET", "/dostep", "POST"],
    ["GET", "/wyloguj", "POST"],
    ["HEAD", "/profil/wypisz", "POST"],
    ["OPTIONS", "/", "GET, HEAD"],
  ])("answers 405 for %s %s with Allow", async (method, path, allow) => {
    const response = await fetch(`${url}${path}`, { method });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe(allow);
    expectSecurityHeaders(response);
  });

  it("refuses a form POST from a foreign Origin before reading it", async () => {
    for (const origin of ["https://evil.example.invalid", "null"]) {
      const response = await fetch(`${url}/wyloguj`, {
        method: "POST",
        headers: { origin, "content-type": FORM },
        body: "csrf=x",
      });
      expect(response.status).toBe(403);
    }
  });

  it.each([
    [undefined],
    ["text/plain"],
    ["application/json"],
    ["multipart/form-data; boundary=x"],
    [`${FORM}; charset=iso-8859-2`],
    [`${FORM}x`],
  ])("answers 415 for Content-Type %j", async (type) => {
    const response = await fetch(`${url}/dostep`, {
      method: "POST",
      headers: type === undefined ? {} : { "content-type": type },
      body: new Blob(["token=x"]),
    });
    expect(response.status).toBe(415);
    expectSecurityHeaders(response);
  });

  it("answers 413 for a body over the limit, declared or streamed", async () => {
    const big = `token=${"a".repeat(MAX_BODY_BYTES)}`;
    const declared = await fetch(`${url}/dostep`, {
      method: "POST",
      headers: { "content-type": FORM },
      body: big,
    });
    expect(declared.status).toBe(413);
    expectSecurityHeaders(declared);

    const chunk = new TextEncoder().encode("a".repeat(4096));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 4) {
          controller.close();
          return;
        }
        sent++;
        controller.enqueue(chunk);
      },
    });
    const streamed = await fetch(`${url}/dostep`, {
      method: "POST",
      headers: { "content-type": FORM },
      body: stream,
      duplex: "half",
    });
    expect(streamed.status).toBe(413);
  });

  it("answers 400 for a malformed login form", async () => {
    for (const body of ["", "token=a&token=b", "token=a&x=1", "x=1"]) {
      const response = await fetch(`${url}/dostep`, {
        method: "POST",
        headers: { "content-type": `${FORM}; charset=UTF-8`, origin: BASE },
        body,
      });
      expect(response.status).toBe(400);
    }
  });

  describe("one-click unsubscribe as multipart/form-data (RFC 8058 §3.2)", () => {
    // A well-shaped token: these bodies are refused before any database lookup.
    const unsubscribePath = `/wypis/${"A".repeat(43)}`;

    function multipart(boundary: string, fields: readonly (readonly [string, string])[]) {
      const parts = fields.flatMap(([name, value]) => [
        `--${boundary}`,
        `Content-Disposition: form-data; name="${name}"`,
        "",
        value,
      ]);
      return [...parts, `--${boundary}--`, ""].join("\r\n");
    }

    function postMultipart(path: string, contentType: string, body: string) {
      return fetch(`${url}${path}`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": contentType },
        body,
      });
    }

    it.each([
      ["no boundary", "multipart/form-data"],
      ["an empty boundary", 'multipart/form-data; boundary=""'],
      ["a 71-character boundary", `multipart/form-data; boundary=${"b".repeat(71)}`],
      ["a boundary with a forbidden character", 'multipart/form-data; boundary="b;b"'],
      ["unparseable parameters", 'multipart/form-data; boundary="b'],
    ])("answers 400 for %s", async (_label, contentType) => {
      const body = multipart("b", [["List-Unsubscribe", "One-Click"]]);
      const response = await postMultipart(unsubscribePath, contentType, body);
      expect(response.status).toBe(400);
      expectSecurityHeaders(response);
    });

    it.each([
      ["a missing field", [["other", "One-Click"]]],
      [
        "a duplicate field",
        [
          ["List-Unsubscribe", "One-Click"],
          ["List-Unsubscribe", "One-Click"],
        ],
      ],
      ["a wrong value", [["List-Unsubscribe", "one-click"]]],
      ["an empty value", [["List-Unsubscribe", ""]]],
      ["a value with extra text", [["List-Unsubscribe", "One-Click\r\n"]]],
    ] as const)("answers 400 for %s", async (_label, fields) => {
      const body = multipart("b", fields);
      const response = await postMultipart(
        unsubscribePath,
        "multipart/form-data; boundary=b",
        body,
      );
      expect(response.status).toBe(400);
    });

    it("answers 400 for a body that does not use the declared boundary", async () => {
      const body = multipart("other", [["List-Unsubscribe", "One-Click"]]);
      const response = await postMultipart(
        unsubscribePath,
        "multipart/form-data; boundary=b",
        body,
      );
      expect(response.status).toBe(400);
    });

    it("answers 413 for a multipart body over 8 KB", async () => {
      const body = multipart("b", [
        ["padding", "x".repeat(MAX_BODY_BYTES)],
        ["List-Unsubscribe", "One-Click"],
      ]);
      const response = await postMultipart(
        unsubscribePath,
        "multipart/form-data; boundary=b",
        body,
      );
      expect(response.status).toBe(413);
    });

    it.each(["/dostep", "/wyloguj", "/profil/wypisz"])(
      "still answers 415 for multipart/form-data on %s",
      async (path) => {
        const body = multipart("b", [["csrf", "x"]]);
        const response = await postMultipart(path, "multipart/form-data; boundary=b", body);
        expect(response.status).toBe(415);
      },
    );
  });

  it("refuses the session pages without a session cookie (401), clearing a bad one", async () => {
    const page = await fetch(`${url}/profil`);
    expect(page.status).toBe(401);
    expect(page.headers.get("set-cookie")).toBeNull();
    expect(await page.text()).toContain("Zaloguj się");

    // A malformed cookie never reaches the database; it is cleared.
    const bad = await fetch(`${url}/profil`, { headers: { cookie: "__Host-radar_sesja=x" } });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("logs method, route name, status and duration only", async () => {
    const token = "Z".repeat(43);
    lines.length = 0;
    await fetch(`${url}/dostep?secret=${token}`, { headers: { cookie: `a=${token}` } });
    await fetch(`${url}/nie-ma/${token}?q=${token}`, { method: "PATCH" });
    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(
        ["durationMs", "level", "message", "method", "route", "status", "time"].sort(),
      );
      expect(entry.message).toBe("http request");
    }
    expect(entries[0]).toMatchObject({ method: "GET", route: "login", status: 405 });
    expect(entries[1]).toMatchObject({ method: "PATCH", route: "not_found", status: 404 });
    expect(lines.join("")).not.toContain(token);
    expect(lines.join("")).not.toContain("secret");
  });

  it("logs a client that aborts mid-body as aborted, not as a failure or a 500", async () => {
    const token = "Q".repeat(43);
    lines.length = 0;
    const socket = connect(server.port, "127.0.0.1");
    await new Promise<void>((resolve) =>
      socket.once("connect", () => {
        resolve();
      }),
    );
    socket.write(
      [
        "POST /dostep HTTP/1.1",
        "Host: 127.0.0.1",
        `Content-Type: ${FORM}`,
        "Content-Length: 200",
        "",
        `token=${token}`,
      ].join("\r\n"),
    );
    // Let the server start reading the body, then drop the connection.
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.destroy();
    for (let i = 0; i < 100 && lines.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Room for a wrong second line (an access line with status 500) to appear.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: "info",
      message: "http request aborted",
      route: "login",
      reason: "aborted",
    });
    expect(Object.keys(entries[0] ?? {}).sort()).toEqual(
      ["level", "message", "reason", "route", "time"].sort(),
    );
    expect(lines.join("")).not.toContain(token);
  });
});
