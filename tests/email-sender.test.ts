import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTransport } from "nodemailer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  classifySmtpError,
  createOutboxSender,
  createSmtpSender,
  EmailSendError,
  mailOptions,
  oneClickUnsubscribeUrl,
  redactTokenLinks,
  sendWithRetry,
  unsubscribeMailto,
  writeAllOrNothing,
  type EmailSender,
  type OutgoingEmail,
} from "../src/notifications/sender.js";

// Pseudonymised data only; nothing here leaves the machine.
const email: OutgoingEmail = {
  to: "kontakt@example.invalid",
  subject: "Radar Zamówień: 1 nowe zamówienie — Jan Kowalski",
  text: "Znaleźliśmy dziś 1 nowe zamówienie pasujące do Twojej firmy.\n",
  html: "<p>Znaleźliśmy dziś 1 nowe zamówienie pasujące do Twojej firmy.</p>\n",
};
const from = { name: "Radar Zamówień", address: "radar@example.invalid" };

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "radar-outbox-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("createOutboxSender", () => {
  it("writes the MIME message and a readable copy, owner-only, under generated names", async () => {
    const outboxDir = join(dir, "outbox");
    const sender = createOutboxSender({ outboxDir, from });
    expect(sender.transport).toBe("test");
    await sender.send(email);
    sender.close();
    const files = (await readdir(outboxDir)).sort();
    expect(files).toHaveLength(2);
    const pattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f-]{36}\.(eml|json)$/;
    for (const file of files) {
      expect(file).toMatch(pattern);
      expect((await stat(join(outboxDir, file))).mode & 0o777).toBe(0o600);
    }
    expect((await stat(outboxDir)).mode & 0o777).toBe(0o700);
    const [eml, json] = files;
    if (eml === undefined || json === undefined) throw new Error("files missing");
    const mime = await readFile(join(outboxDir, eml), "utf8");
    expect(mime).toContain("To: kontakt@example.invalid");
    expect(mime).toMatch(/^Subject: /m);
    expect(mime).toContain("Content-Type: multipart/alternative");
    expect(JSON.parse(await readFile(join(outboxDir, json), "utf8"))).toEqual({ from, ...email });
  });

  it("keeps the token links in the .eml but redacts them in the .json copy", async () => {
    const loginToken = "L0gin_Token-".padEnd(43, "x");
    const unsubscribeToken = "Wypis_Token-".padEnd(43, "y");
    const login = `https://radar.example.invalid/dostep/${loginToken}`;
    const unsubscribe = `https://radar.example.invalid/wypis/${unsubscribeToken}`;
    const outboxDir = join(dir, "outbox-redacted");
    const sender = createOutboxSender({ outboxDir, from });
    await sender.send({
      ...email,
      text: `Profil:\n${login}\nWypis:\n${unsubscribe}\n`,
      html: `<p><a href="${login}">${login}</a></p>\n<p><a href="${unsubscribe}">${unsubscribe}</a></p>\n`,
      unsubscribeUrl: unsubscribe,
    });
    sender.close();
    const files = (await readdir(outboxDir)).sort();
    const [eml, json] = files;
    if (eml === undefined || json === undefined) throw new Error("files missing");

    // Unfold quoted-printable soft line breaks before searching the MIME text.
    const mimeText = (await readFile(join(outboxDir, eml), "utf8")).replace(/=\r?\n/g, "");
    expect(mimeText).toContain(`/dostep/${loginToken}`);
    expect(mimeText).toContain(`/wypis/${unsubscribeToken}`);

    const copy = await readFile(join(outboxDir, json), "utf8");
    expect(copy).not.toContain(loginToken);
    expect(copy).not.toContain(unsubscribeToken);
    const parsed = JSON.parse(copy) as { text: string; html: string };
    expect(parsed.text).toBe(
      "Profil:\nhttps://radar.example.invalid/dostep/[token]\n" +
        "Wypis:\nhttps://radar.example.invalid/wypis/[token]\n",
    );
    expect(parsed.html).toContain(
      '<a href="https://radar.example.invalid/dostep/[token]">' +
        "https://radar.example.invalid/dostep/[token]</a>",
    );
    expect(parsed.html).not.toMatch(/\/(dostep|wypis)\/(?!\[token\])/);
  });

  it("reports an outbox that cannot be written as a setup failure", async () => {
    const blocked = join(dir, "not-a-directory");
    await writeFile(blocked, "");
    const sender = createOutboxSender({ outboxDir: blocked, from });
    const failure = await sender.send(email).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(EmailSendError);
    expect(failure).toMatchObject({ code: "outbox_write_failed", kind: "setup" });
  });
});

/** The MIME message nodemailer builds from mailOptions (what both senders hand over). */
async function mime(sender: { name: string; address: string }): Promise<string> {
  const transporter = createTransport({ streamTransport: true, buffer: true, newline: "unix" });
  const info = await transporter.sendMail(mailOptions(sender, email));
  if (!Buffer.isBuffer(info.message)) throw new Error("no buffer");
  return info.message.toString("utf8");
}

function headerLines(message: string): string[] {
  const head = message.split("\n\n")[0] ?? "";
  // Unfold continuation lines, so every header is one line.
  return head.replace(/\n[ \t]+/g, " ").split("\n");
}

describe("List-Unsubscribe", () => {
  it("is a mailto: to the bare sender address, without the display name", async () => {
    const lines = headerLines(await mime(from));
    expect(lines).toContain(
      "List-Unsubscribe: <mailto:radar@example.invalid?subject=wypis> (Wypisz)",
    );
    const header = lines.find((line) => line.startsWith("List-Unsubscribe:")) ?? "";
    expect(header).not.toContain("Radar");
  });

  it("is in the outbox copy too, as an SMTP send would carry it", async () => {
    const outboxDir = join(dir, "outbox-unsubscribe");
    await createOutboxSender({ outboxDir, from }).send(email);
    const files = (await readdir(outboxDir)).filter((file) => file.endsWith(".eml"));
    const [eml] = files;
    if (eml === undefined) throw new Error("no .eml");
    expect(headerLines(await readFile(join(outboxDir, eml), "utf8"))).toContain(
      "List-Unsubscribe: <mailto:radar@example.invalid?subject=wypis> (Wypisz)",
    );
  });

  it.each([
    ["radar@example.invalid", "mailto:radar@example.invalid?subject=wypis"],
    // Percent-encoded where the URL needs it.
    ["radar+wypis@example.invalid", "mailto:radar%2Bwypis@example.invalid?subject=wypis"],
    ["a?b&c=d#e@example.invalid", "mailto:a%3Fb%26c%3Dd%23e@example.invalid?subject=wypis"],
    // Header injection or anything but one plain address: no header at all.
    ["radar@example.invalid\r\nBcc: x@example.invalid", null],
    ["radar@example.invalid\nBcc:x@example.invalid", null],
    ["radar@example.invalid>, <mailto:x@example.invalid", null],
    ["Radar <radar@example.invalid>", null],
    ["radar@example.invalid (komentarz)", null],
    ["radar@@example.invalid", null],
    ["radar", null],
    ["", null],
  ])("%j → %s", (address, url) => {
    expect(unsubscribeMailto(address)).toBe(url);
  });

  it("is left out, and nothing injected, when the address is not plain", async () => {
    const lines = headerLines(
      await mime({ name: "Radar", address: "radar@example.invalid\r\nBcc: x@example.invalid" }),
    );
    expect(lines.some((line) => line.startsWith("List-Unsubscribe:"))).toBe(false);
    expect(lines.some((line) => /^bcc:/i.test(line))).toBe(false);
  });
});

describe("writeAllOrNothing", () => {
  it("removes the files already written when a later one fails", async () => {
    const target = join(dir, "partial");
    await mkdir(target);
    const first = join(target, "message.eml");
    // A directory where the second file should go: its write fails (EISDIR).
    const second = join(target, "taken");
    await mkdir(second);
    await expect(
      writeAllOrNothing([
        { path: first, data: "first" },
        { path: second, data: "second" },
      ]),
    ).rejects.toThrow();
    expect((await readdir(target)).sort()).toEqual(["taken"]);
  });

  it("never overwrites an existing file", async () => {
    const existing = join(dir, "existing.eml");
    await writeFile(existing, "kept");
    await expect(writeAllOrNothing([{ path: existing, data: "new" }])).rejects.toThrow();
    expect(await readFile(existing, "utf8")).toBe("kept");
  });
});

describe("classifySmtpError", () => {
  it.each([
    // A reply about this message (or at an unknown stage).
    [{ responseCode: 451 }, "smtp_451", "transient"],
    [{ responseCode: 550, code: "EENVELOPE" }, "smtp_550", "permanent"],
    [{ responseCode: 452, code: "EENVELOPE", command: "RCPT TO" }, "smtp_452", "transient"],
    [{ responseCode: 550, code: "EENVELOPE", command: "RCPT TO" }, "smtp_550", "permanent"],
    [{ responseCode: 451, code: "EMESSAGE", command: "DATA" }, "smtp_451", "transient"],
    [{ responseCode: 554, code: "EMESSAGE", command: "DATA" }, "smtp_554", "permanent"],
    [{ responseCode: 451, code: "EENVELOPE", command: "MAIL FROM" }, "smtp_451", "transient"],
    // Rejected locally before any command: not distinguishable, so about the message.
    [{ code: "EENVELOPE", command: "API" }, "smtp_eenvelope", "permanent"],
    // The configuration or the server refuses every message: never retried, the run stops.
    [{ responseCode: 535, code: "EAUTH", command: "AUTH PLAIN" }, "smtp_535", "setup"],
    [{ responseCode: 454, code: "EAUTH", command: "AUTH LOGIN" }, "smtp_454", "setup"],
    [{ responseCode: 535, code: "EAUTH" }, "smtp_535", "setup"],
    [{ code: "EAUTH", command: "API" }, "smtp_eauth", "setup"],
    [{ code: "EAUTH" }, "smtp_eauth", "setup"],
    [{ responseCode: 454, code: "ETLS", command: "STARTTLS" }, "smtp_454", "setup"],
    [{ responseCode: 530, code: "ETLS", command: "STARTTLS" }, "smtp_530", "setup"],
    [{ code: "ETLS", command: "CONN" }, "smtp_etls", "setup"],
    [{ code: "ETLS" }, "smtp_etls", "setup"],
    [{ code: "ESOCKET", originalCode: "CERT_HAS_EXPIRED" }, "smtp_cert_has_expired", "setup"],
    [
      { code: "ESOCKET", originalCode: "ERR_TLS_CERT_ALTNAME_INVALID", command: "CONN" },
      "smtp_err_tls_cert_altname_invalid",
      "setup",
    ],
    [
      { code: "ESOCKET", originalCode: "DEPTH_ZERO_SELF_SIGNED_CERT" },
      "smtp_depth_zero_self_signed_cert",
      "setup",
    ],
    [{ responseCode: 553, code: "EENVELOPE", command: "MAIL FROM" }, "smtp_553", "setup"],
    [{ responseCode: 554, code: "EPROTOCOL", command: "CONN" }, "smtp_554", "setup"],
    [{ responseCode: 554, code: "EPROTOCOL", command: "HELO" }, "smtp_554", "setup"],
    // With STARTTLS required, nodemailer reports a refused EHLO as ECONNECTION.
    [{ responseCode: 550, code: "ECONNECTION", command: "EHLO" }, "smtp_550", "setup"],
    [{ responseCode: 550, code: "EPROTOCOL", command: "EHLO" }, "smtp_550", "setup"],
    // Not reached, nothing sent: retried in the run; if it persists, the run stops.
    [{ code: "EDNS" }, "smtp_edns", "unreachable"],
    [{ code: "ESOCKET", originalCode: "ECONNREFUSED" }, "smtp_econnrefused", "unreachable"],
    [{ code: "ETIMEDOUT", timeoutType: "CONNECT_TIMEOUT" }, "smtp_etimedout", "unreachable"],
    [{ code: "ETIMEDOUT", timeoutType: "GREETING_TIMEOUT" }, "smtp_etimedout", "unreachable"],
    [{ code: "ETIMEDOUT", timeoutType: "UPGRADE_TIMEOUT" }, "smtp_etimedout", "unreachable"],
    [{ responseCode: 421, code: "EPROTOCOL", command: "CONN" }, "smtp_421", "unreachable"],
    [{ responseCode: 450, code: "EPROTOCOL", command: "CONN" }, "smtp_450", "unreachable"],
    [{ responseCode: 451, code: "ECONNECTION", command: "EHLO" }, "smtp_451", "unreachable"],
    [{ responseCode: 421, code: "ECONNECTION", command: "CONN" }, "smtp_421", "unreachable"],
    // 421: the server is closing the session, whatever the stage.
    [{ responseCode: 421, code: "EENVELOPE" }, "smtp_421", "unreachable"],
    [{ responseCode: 421, code: "EENVELOPE", command: "MAIL FROM" }, "smtp_421", "unreachable"],
    [{ responseCode: 421, code: "EENVELOPE", command: "RCPT TO" }, "smtp_421", "unreachable"],
    [{ responseCode: 421, code: "EMESSAGE", command: "DATA" }, "smtp_421", "unreachable"],
    // A reply left over at close may answer the message itself: classified by its code.
    [{ responseCode: 554, code: "ECONNECTION", command: "CONN" }, "smtp_554", "permanent"],
    [{ responseCode: 451, code: "ECONNECTION", command: "CONN" }, "smtp_451", "transient"],
    // No reply and possibly after the message: never resent.
    [{ code: "ETIMEDOUT", timeoutType: "SOCKET_TIMEOUT" }, "smtp_etimedout", "uncertain"],
    [{ code: "ECONNECTION" }, "smtp_econnection", "uncertain"],
    [{ code: "ESOCKET", originalCode: "ECONNRESET" }, "smtp_econnreset", "uncertain"],
    [{ code: "ESOCKET", originalCode: "EPROTO" }, "smtp_eproto", "uncertain"],
    // nodemailer reports these the same at connect time and mid-session.
    [
      { code: "ESOCKET", originalCode: "EHOSTUNREACH", command: "CONN" },
      "smtp_ehostunreach",
      "uncertain",
    ],
    [{ code: "ESOCKET", originalCode: "ENETUNREACH" }, "smtp_enetunreach", "uncertain"],
    [{ code: "Weird-Code!" }, "smtp_weird_code_", "permanent"],
    [{}, "send_failed", "permanent"],
    ["a string", "send_failed", "permanent"],
  ])("%j → %s (%s)", (error, code, kind) => {
    expect(classifySmtpError(error)).toMatchObject({ code, kind });
  });

  it("never reads the message or the server reply", () => {
    const failure = classifySmtpError(
      Object.assign(new Error("550 kontakt@example.invalid: no such user"), {
        responseCode: 550,
        response: "550 kontakt@example.invalid: no such user",
      }),
    );
    expect(failure.code).toBe("smtp_550");
    expect(failure.message).not.toContain("example.invalid");
  });

  it("produces codes the deliveries table accepts", () => {
    const failure = classifySmtpError({ code: "E".repeat(100) });
    expect(failure.code).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
  });
});

function scriptedSender(outcomes: (EmailSendError | null)[]): EmailSender & { sent: number } {
  const sender = {
    transport: "test" as const,
    sent: 0,
    send() {
      sender.sent++;
      const outcome = outcomes.shift() ?? null;
      return outcome === null ? Promise.resolve() : Promise.reject(outcome);
    },
    close() {},
  };
  return sender;
}

describe("sendWithRetry", () => {
  const transient = () => new EmailSendError("smtp_451", "transient");

  it("retries transient failures after each pause, then succeeds", async () => {
    const sender = scriptedSender([transient(), transient(), null]);
    const pauses: number[] = [];
    const result = await sendWithRetry(sender, email, {
      sleep: (ms) => {
        pauses.push(ms);
        return Promise.resolve();
      },
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ ok: true });
    expect(sender.sent).toBe(3);
    expect(pauses).toEqual([2_000, 10_000]);
  });

  it("gives up after the last pause", async () => {
    const sender = scriptedSender([transient(), transient(), transient(), null]);
    const result = await sendWithRetry(sender, email, {
      sleep: () => Promise.resolve(),
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "smtp_451" } });
    expect(sender.sent).toBe(3);
  });

  it("retries an unreachable server like a transient failure", async () => {
    const sender = scriptedSender([new EmailSendError("smtp_econnrefused", "unreachable"), null]);
    const result = await sendWithRetry(sender, email, {
      sleep: () => Promise.resolve(),
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ ok: true });
    expect(sender.sent).toBe(2);
  });

  it.each(["permanent", "setup", "uncertain"] as const)(
    "never retries a %s failure",
    async (kind) => {
      const sender = scriptedSender([new EmailSendError("smtp_x", kind), null]);
      const result = await sendWithRetry(sender, email, {
        sleep: () => Promise.reject(new Error("must not wait")),
        signal: new AbortController().signal,
      });
      expect(result).toMatchObject({ ok: false, error: { kind } });
      expect(sender.sent).toBe(1);
    },
  );

  it("stops retrying once the run's signal is aborted", async () => {
    const controller = new AbortController();
    const sender = scriptedSender([transient(), null]);
    const result = await sendWithRetry(sender, email, {
      sleep: () => {
        controller.abort();
        return Promise.resolve();
      },
      signal: controller.signal,
    });
    expect(result).toMatchObject({ ok: false, error: { kind: "transient" } });
    expect(sender.sent).toBe(1);
  });

  it("treats an unexpected error as a permanent failure without its message", async () => {
    const sender: EmailSender = {
      transport: "test",
      send: () => Promise.reject(new Error("kontakt@example.invalid")),
      close() {},
    };
    const result = await sendWithRetry(sender, email, {
      sleep: () => Promise.resolve(),
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "send_failed", kind: "permanent" } });
  });
});

/**
 * A local plaintext SMTP server that does not offer STARTTLS and refuses
 * it (127.0.0.1 only). It records every command so the test can prove nothing past EHLO
 * was sent: no credentials, no envelope, no message.
 */
describe("createSmtpSender against a server without STARTTLS", () => {
  let server: Server;
  let port: number;
  const commands: string[] = [];
  const sockets = new Set<Socket>();

  beforeAll(async () => {
    server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.write("220 localhost ESMTP test\r\n");
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("latin1");
        let index: number;
        while ((index = buffer.indexOf("\r\n")) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          commands.push(line.split(" ")[0]?.toUpperCase() ?? "");
          if (/^(EHLO|HELO)/i.test(line)) socket.write("250-localhost\r\n250 AUTH PLAIN LOGIN\r\n");
          else if (/^STARTTLS/i.test(line)) socket.write("454 TLS not available\r\n");
          else if (/^QUIT/i.test(line)) socket.end("221 bye\r\n");
          else socket.write("250 ok\r\n");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    port = address.port;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  it("refuses to continue in plaintext: no AUTH, MAIL or DATA is sent", async () => {
    const sender = createSmtpSender({
      from,
      smtp: {
        host: "127.0.0.1",
        port,
        implicitTls: false,
        user: "radar",
        password: "not-a-real-password",
      },
    });
    expect(sender.transport).toBe("smtp");
    const failure = await sender.send(email).then(
      () => null,
      (error: unknown) => error,
    );
    sender.close();
    // The 454 reply: certainly not delivered, and no message can be: a setup failure.
    expect(failure).toBeInstanceOf(EmailSendError);
    expect(failure).toMatchObject({ code: "smtp_454", kind: "setup" });
    expect(commands).toEqual(expect.arrayContaining(["EHLO", "STARTTLS"]));
    expect(
      commands.filter((command) => ["AUTH", "MAIL", "RCPT", "DATA"].includes(command)),
    ).toEqual([]);
  });
});

describe("one-click List-Unsubscribe (RFC 8058)", () => {
  const token = "a".repeat(43);
  const oneClick = `https://radar.example.invalid/wypis/${token}`;

  async function mimeWith(unsubscribeUrl: string | undefined, sender = from) {
    const transporter = createTransport({ streamTransport: true, buffer: true, newline: "unix" });
    const info = await transporter.sendMail(
      mailOptions(sender, {
        ...email,
        ...(unsubscribeUrl === undefined ? {} : { unsubscribeUrl }),
      }),
    );
    if (!Buffer.isBuffer(info.message)) throw new Error("no buffer");
    return headerLines(info.message.toString("utf8"));
  }

  it("puts the https link first, then the mailto:, and adds List-Unsubscribe-Post", async () => {
    const lines = await mimeWith(oneClick);
    expect(lines).toContain(
      `List-Unsubscribe: <${oneClick}>, <mailto:radar@example.invalid?subject=wypis> (Wypisz)`,
    );
    expect(lines).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    expect(lines.filter((line) => line.startsWith("List-Unsubscribe:"))).toHaveLength(1);
  });

  it("keeps the https link alone when the sender address is not plain", async () => {
    const lines = await mimeWith(oneClick, { name: "Radar", address: "Radar <x@example.invalid>" });
    expect(lines).toContain(`List-Unsubscribe: <${oneClick}>`);
    expect(lines).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  });

  it("keeps the mailto-only header and no Post header without a link", async () => {
    const lines = await mimeWith(undefined);
    expect(lines).toContain(
      "List-Unsubscribe: <mailto:radar@example.invalid?subject=wypis> (Wypisz)",
    );
    expect(lines.some((line) => line.startsWith("List-Unsubscribe-Post:"))).toBe(false);
  });

  it.each([
    [oneClick, oneClick],
    [`http://localhost:3000/wypis/${token}`, `http://localhost:3000/wypis/${token}`],
    [
      `https://radar.example.invalid:8443/wypis/${token}`,
      `https://radar.example.invalid:8443/wypis/${token}`,
    ],
    [undefined, null],
    [`http://radar.example.invalid/wypis/${token}`, null],
    [`https://radar.example.invalid/dostep/${token}`, null],
    [`https://radar.example.invalid/wypis/${token}?x=1`, null],
    [`https://radar.example.invalid/wypis/${token}>, <https://evil.example.invalid`, null],
    [`https://radar.example.invalid/wypis/${token}\r\nBcc: x@example.invalid`, null],
    [`https://user@radar.example.invalid/wypis/${token}`, null],
    [`https://RADAR.example.invalid/wypis/${token}`, null],
    [`https://radar.example.invalid/wypis/${token.slice(1)}`, null],
  ])("oneClickUnsubscribeUrl(%j) → %j", (value, expected) => {
    expect(oneClickUnsubscribeUrl(value)).toBe(expected);
  });

  it.each([
    // PUBLIC_BASE_URL is normalised to its origin, so an IDN host arrives as punycode.
    [`https://xn--radar-zamwie-8hb15i.example.invalid/wypis/${token}`, true],
    // An IPv6 literal host is not in the accepted form: the mailto: stays alone.
    [`https://[2001:db8::1]/wypis/${token}`, false],
  ])("oneClickUnsubscribeUrl accepts %j: %j", (value, accepted) => {
    expect(oneClickUnsubscribeUrl(value)).toBe(accepted ? value : null);
  });

  it("drops a malformed link and its Post header, keeping the mailto:", async () => {
    const lines = await mimeWith(`${oneClick}\r\nBcc: x@example.invalid`);
    expect(lines).toContain(
      "List-Unsubscribe: <mailto:radar@example.invalid?subject=wypis> (Wypisz)",
    );
    expect(lines.some((line) => line.startsWith("List-Unsubscribe-Post:"))).toBe(false);
    expect(lines.some((line) => /^bcc:/i.test(line))).toBe(false);
  });
});

describe("redactTokenLinks", () => {
  const token = "T".repeat(43);

  it("replaces only the 43-character token after /dostep/ and /wypis/", () => {
    expect(
      redactTokenLinks(`a https://x.invalid/dostep/${token} b /wypis/${token}" /profil/${token}`),
    ).toBe(`a https://x.invalid/dostep/[token] b /wypis/[token]" /profil/${token}`);
    expect(redactTokenLinks(`/dostep/${token.slice(1)}`)).toBe(`/dostep/${token.slice(1)}`);
    expect(redactTokenLinks("bez linków")).toBe("bez linków");
  });

  it("replaces the token of an address confirmation link too (D-031)", () => {
    expect(redactTokenLinks(`https://x.invalid/potwierdz-email/${token}\n`)).toBe(
      "https://x.invalid/potwierdz-email/[token]\n",
    );
    expect(redactTokenLinks(`/potwierdz-email/${token.slice(1)}`)).toBe(
      `/potwierdz-email/${token.slice(1)}`,
    );
  });

  it("replaces the token of a rating link and keeps the offer id and verdict (D-032)", () => {
    const oppId = "0b6f3c1e-1d2a-4c5b-9e8f-7a6b5c4d3e2f";
    expect(redactTokenLinks(`https://x.invalid/ocena/${token}/${oppId}/trafne\n`)).toBe(
      `https://x.invalid/ocena/[token]/${oppId}/trafne\n`,
    );
    expect(redactTokenLinks(`<a href="/ocena/${token}/${oppId}/nietrafne">`)).toBe(
      `<a href="/ocena/[token]/${oppId}/nietrafne">`,
    );
    expect(redactTokenLinks(`/ocena/${token.slice(1)}/${oppId}/trafne`)).toBe(
      `/ocena/${token.slice(1)}/${oppId}/trafne`,
    );
  });
});

describe("an operator e-mail (status --notify, PR-07A)", () => {
  // Plain text, no List-Unsubscribe: it goes to the operator, not to a customer.
  const alert: OutgoingEmail = {
    to: "operator@example.invalid",
    subject: "Radar Zamówień: problem (source_failed)",
    text: "Radar Zamówień — status: problem\n",
    listUnsubscribe: false,
    unsubscribeUrl: `https://radar.example.invalid/wypis/${"a".repeat(43)}`,
  };

  it("has no List-Unsubscribe header (not even with a link) and no HTML part", async () => {
    const options = mailOptions(from, alert);
    expect(options).not.toHaveProperty("html");
    expect(options).not.toHaveProperty("list");
    expect(options).not.toHaveProperty("headers");
    const transporter = createTransport({ streamTransport: true, buffer: true, newline: "unix" });
    const info = await transporter.sendMail(options);
    if (!Buffer.isBuffer(info.message)) throw new Error("no buffer");
    const message = info.message.toString("utf8");
    const lines = headerLines(message);
    expect(lines.some((line) => /^list-unsubscribe/i.test(line))).toBe(false);
    expect(message).toContain("Content-Type: text/plain");
    expect(message).not.toContain("text/html");
  });

  it("is written to the outbox with html null in the readable copy", async () => {
    const outboxDir = join(dir, "outbox-operator");
    await createOutboxSender({ outboxDir, from }).send(alert);
    const files = (await readdir(outboxDir)).sort();
    const json = files.find((file) => file.endsWith(".json"));
    if (json === undefined) throw new Error("no .json");
    expect(JSON.parse(await readFile(join(outboxDir, json), "utf8"))).toEqual({
      from,
      to: alert.to,
      subject: alert.subject,
      text: alert.text,
      html: null,
    });
  });

  it("keeps List-Unsubscribe for an e-mail that does not opt out", () => {
    expect(mailOptions(from, { ...email, listUnsubscribe: true })).toHaveProperty("list");
    expect(mailOptions(from, email)).toHaveProperty("list");
  });
});
