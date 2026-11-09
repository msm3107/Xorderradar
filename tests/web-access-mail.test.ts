import { setTimeout as delay } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import { createDatabase } from "../src/infrastructure/db/database.js";
import { createLogger } from "../src/infrastructure/logger.js";
import {
  EMAIL_CHANGE_NOTICE_SUBJECT,
  EMAIL_CHANGE_SUBJECT,
  emailChangeEmail,
  emailChangeNoticeEmail,
  LOGIN_LINK_SUBJECT,
  loginLinkEmail,
} from "../src/notifications/access-emails.js";
import {
  EmailSendError,
  type EmailSender,
  type OutgoingEmail,
} from "../src/notifications/sender.js";
import { createAccessMailer } from "../src/web/access-mail.js";
import { createMailQueue, MAIL_QUEUE_MAX_PENDING } from "../src/web/mail-queue.js";
import { clientAddress, createRateLimiter, rateLimitKey } from "../src/web/rate-limit.js";

/*
 * The in-memory parts of „Wyślij mi link” and the address change (D-031):
 * the per-IP limit, the client address behind the proxy, the bounded mail
 * queue, the e-mails and their sending. No database: where one is needed it
 * points at a closed port. Pseudonymised data only.
 */

const BASE = "https://radar.example.invalid";
const TOKEN = "T".repeat(43);
const OLD = "kontakt@example.invalid";
const NEW = "biuro@example.invalid";
const PROFILE_ID = "00000000-0000-4000-8000-000000000001";

/** A promise with its resolve, to hold a job or a send until the test lets it go. */
function gate() {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

async function until(condition: () => boolean): Promise<void> {
  for (let waited = 0; !condition(); waited += 5) {
    if (waited > 2000) throw new Error("condition not reached");
    await delay(5);
  }
}

describe("createRateLimiter", () => {
  function limiter(maxEntries = 100) {
    let time = 0;
    const limit = createRateLimiter({ limit: 3, windowMs: 1000, maxEntries, now: () => time });
    return {
      limit,
      advance: (ms: number) => {
        time += ms;
      },
    };
  }

  it("allows `limit` requests per key and window, each key on its own", () => {
    const { limit } = limiter();
    expect([1, 2, 3, 4].map(() => limit.allow("a"))).toEqual([true, true, true, false]);
    expect(limit.allow("b")).toBe(true);
    // A refused request is not counted, and refusing does not extend the window.
    expect(limit.allow("a")).toBe(false);
  });

  it("opens a new window once the first one has passed, forgetting expired keys", () => {
    const { limit, advance } = limiter();
    for (let i = 0; i < 3; i++) limit.allow("a");
    advance(500);
    limit.allow("b");
    advance(499);
    expect(limit.allow("a")).toBe(false);
    advance(1);
    expect(limit.allow("a")).toBe(true);
    // "b" is still within its window; the old window of "a" was dropped.
    expect(limit.size).toBe(2);
    advance(1000);
    limit.allow("c");
    expect(limit.size).toBe(1);
  });

  it("stays within maxEntries, forgetting the oldest window first", () => {
    const { limit, advance } = limiter(2);
    for (let i = 0; i < 3; i++) limit.allow("a");
    advance(1);
    limit.allow("b");
    advance(1);
    limit.allow("c");
    expect(limit.size).toBe(2);
    // "a" was evicted (the oldest window), so it starts over — evicting "b" in turn.
    expect(limit.allow("a")).toBe(true);
    expect(limit.size).toBe(2);
    expect(limit.allow("c")).toBe(true);
    expect(limit.allow("b")).toBe(true);
  });
});

describe("clientAddress", () => {
  it("is the socket address of a direct client, whatever X-Forwarded-For says", () => {
    expect(clientAddress("203.0.113.7", "198.51.100.1")).toBe("203.0.113.7");
    expect(clientAddress("::ffff:203.0.113.7", undefined)).toBe("203.0.113.7");
    expect(clientAddress("2001:DB8::1", "198.51.100.1")).toBe("2001:db8::1");
  });

  it("is the last X-Forwarded-For entry behind the proxy on loopback", () => {
    for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect(clientAddress(peer, "198.51.100.1")).toBe("198.51.100.1");
    }
    // A client-sent entry comes first; the proxy appends the real one.
    expect(clientAddress("127.0.0.1", "192.0.2.9, 198.51.100.1")).toBe("198.51.100.1");
    expect(clientAddress("127.0.0.1", ["192.0.2.9", "198.51.100.1 , 198.51.100.2"])).toBe(
      "198.51.100.2",
    );
    expect(clientAddress("127.0.0.1", "::ffff:198.51.100.1")).toBe("198.51.100.1");
    expect(clientAddress("127.0.0.1", "2001:DB8::2")).toBe("2001:db8::2");
  });

  it("falls back to the peer address for an absent or malformed header", () => {
    for (const header of [undefined, "", "unknown", "198.51.100.1, x", "198.51.100.1:443", []]) {
      expect(clientAddress("127.0.0.1", header)).toBe("127.0.0.1");
    }
    expect(clientAddress(undefined, "198.51.100.1")).toBe("");
  });
});

describe("rateLimitKey", () => {
  it("keys IPv4 by the address and native IPv6 by its /64", () => {
    expect(rateLimitKey("203.0.113.7")).toBe("203.0.113.7");
    expect(rateLimitKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(rateLimitKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(rateLimitKey("::1")).toBe("0:0:0:0::/64");
    expect(rateLimitKey("")).toBe("");
  });

  it("gives every spelling of one address the same key", () => {
    for (const spelling of [
      "2001:db8:1:2::1",
      "2001:DB8:1:2:0:0:0:1",
      "2001:0db8:0001:0002:0000:0000:0000:0001",
      "2001:db8:1:2:0::1",
      "2001:db8:1:2::0.0.0.1",
      "2001:db8:1:2::1%eth0",
    ]) {
      expect(rateLimitKey(spelling)).toBe("2001:db8:1:2::/64");
    }
    expect(rateLimitKey("1::")).toBe("1:0:0:0::/64");
    expect(rateLimitKey("1:2:3:4:5:6:7::")).toBe("1:2:3:4::/64");
  });

  it("keeps an IPv4-mapped address per IPv4 address, in any spelling", () => {
    for (const mapped of [
      "::ffff:198.51.100.1",
      "::FFFF:c633:6401",
      "0:0:0:0:0:ffff:198.51.100.1",
    ]) {
      expect(rateLimitKey(mapped)).toBe("198.51.100.1");
    }
    expect(rateLimitKey("::ffff:198.51.100.2")).not.toBe(rateLimitKey("::ffff:198.51.100.1"));
    // NAT64 is not IPv4-mapped: a native IPv6 /64.
    expect(rateLimitKey("64:ff9b::198.51.100.1")).toBe("64:ff9b:0:0::/64");
  });

  it("gives addresses in one /64 one count, and other /64s their own", () => {
    const limit = createRateLimiter({ limit: 2, windowMs: 1000, maxEntries: 100, now: () => 0 });
    const allow = (address: string) => limit.allow(rateLimitKey(clientAddress(address, undefined)));
    expect(allow("2001:db8:1:2::a")).toBe(true);
    expect(allow("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe(true);
    expect(allow("2001:DB8:1:2:0:0:0:B")).toBe(false);
    expect(allow("2001:db8:1:3::a")).toBe(true);
    expect(allow("2001:db8:2:2::a")).toBe(true);
    // IPv4-mapped clients stay one count per IPv4 address.
    expect(allow("::ffff:198.51.100.1")).toBe(true);
    expect(allow("::ffff:198.51.100.1")).toBe(true);
    expect(allow("::ffff:198.51.100.1")).toBe(false);
    expect(allow("::ffff:198.51.100.2")).toBe(true);
    expect(limit.size).toBe(5);
  });
});

describe("createMailQueue", () => {
  it("runs the jobs one at a time, in order, after the current turn", async () => {
    const order: string[] = [];
    const first = gate();
    const queue = createMailQueue(() => undefined);
    expect(
      queue.push(async () => {
        order.push("1 start");
        await first.opened;
        order.push("1 end");
      }),
    ).toBe(true);
    queue.push(() => {
      order.push("2");
      return Promise.resolve();
    });
    // Nothing runs before the caller has answered its request.
    expect(order).toEqual([]);
    await until(() => order.length === 1);
    expect(queue.pending).toBe(1);
    await delay(20);
    expect(order).toEqual(["1 start"]);
    first.open();
    await until(() => order.length === 3);
    expect(order).toEqual(["1 start", "1 end", "2"]);
    expect(queue.pending).toBe(0);
    // An idle queue starts again for a new job.
    queue.push(() => {
      order.push("3");
      return Promise.resolve();
    });
    await until(() => order.length === 4);
  });

  it(`holds at most ${String(MAIL_QUEUE_MAX_PENDING)} waiting jobs by default and drops the rest`, async () => {
    const running = gate();
    const queue = createMailQueue(() => undefined);
    const ran: number[] = [];
    queue.push(() => running.opened);
    await delay(5);
    const accepted = Array.from({ length: MAIL_QUEUE_MAX_PENDING + 5 }, (_, index) =>
      queue.push(() => {
        ran.push(index);
        return Promise.resolve();
      }),
    );
    expect(accepted.filter(Boolean)).toHaveLength(MAIL_QUEUE_MAX_PENDING);
    expect(accepted.slice(MAIL_QUEUE_MAX_PENDING)).toEqual([false, false, false, false, false]);
    running.open();
    await until(() => ran.length === MAIL_QUEUE_MAX_PENDING);
    // A place is free again once the jobs have run.
    expect(queue.push(() => Promise.resolve())).toBe(true);
  });

  it("reports a failing job and goes on with the next one", async () => {
    const errors: unknown[] = [];
    const queue = createMailQueue((error) => errors.push(error));
    let ran = false;
    queue.push(() => Promise.reject(new Error("bug")));
    queue.push(() => {
      ran = true;
      return Promise.resolve();
    });
    await until(() => ran);
    expect(errors).toHaveLength(1);
  });

  it("on close drops the waiting jobs, waits for the running one and refuses new ones", async () => {
    const running = gate();
    let finished = false;
    let dropped = false;
    const queue = createMailQueue(() => undefined, 5);
    queue.push(async () => {
      await running.opened;
      finished = true;
    });
    queue.push(() => {
      dropped = true;
      return Promise.resolve();
    });
    await delay(5);
    const closing = queue.close(2000);
    expect(queue.closed).toBe(true);
    expect(queue.push(() => Promise.resolve())).toBe(false);
    running.open();
    expect(await closing).toEqual({ dropped: 1, timedOut: false });
    expect(finished).toBe(true);
    expect(dropped).toBe(false);
    const idle = createMailQueue(() => undefined);
    expect(idle.closed).toBe(false);
    expect(await idle.close(2000)).toEqual({ dropped: 0, timedOut: false });
  });

  it("on close waits for a job that never ends only until the deadline", async () => {
    const queue = createMailQueue(() => undefined);
    queue.push(() => new Promise<void>(() => undefined));
    await delay(5);
    const started = performance.now();
    expect(await queue.close(50)).toEqual({ dropped: 0, timedOut: true });
    const waited = performance.now() - started;
    expect(waited).toBeGreaterThanOrEqual(45);
    expect(waited).toBeLessThan(1000);
  });
});

describe("access e-mails", () => {
  it("send the login link: single use, 7 days, ignore if not you", () => {
    const email = loginLinkEmail(BASE, OLD, TOKEN);
    expect(email).toMatchObject({ to: OLD, subject: LOGIN_LINK_SUBJECT, listUnsubscribe: false });
    expect(LOGIN_LINK_SUBJECT).toBe("Radar Zamówień: link do profilu");
    expect(email.text).toContain(`${BASE}/dostep/${TOKEN}\n`);
    expect(email.text).toContain("działa raz przez 7 dni");
    expect(email.text).toContain("Jeśli to nie Ty — zignoruj tę wiadomość");
    expect(email.html).toBeUndefined();
  });

  it("send the confirmation link to the new address: single use, 24 hours", () => {
    const email = emailChangeEmail(BASE, NEW, TOKEN);
    expect(email).toMatchObject({ to: NEW, subject: EMAIL_CHANGE_SUBJECT, listUnsubscribe: false });
    expect(email.text).toContain(`${BASE}/potwierdz-email/${TOKEN}\n`);
    expect(email.text).toContain("link działa raz przez 24 godziny");
    expect(email.text).toContain("Jeśli to nie Ty — zignoruj tę wiadomość");
    expect(email.text).not.toContain(OLD);
  });

  it("send the old address a notice with no link and not the new address", () => {
    const email = emailChangeNoticeEmail(OLD, null);
    expect(email).toMatchObject({
      to: OLD,
      subject: EMAIL_CHANGE_NOTICE_SUBJECT,
      listUnsubscribe: false,
    });
    expect(email.text).not.toMatch(/https?:|\/dostep\/|\/potwierdz-email\/|@/);
    expect(email.text).toContain("Dzień dobry,\n\npoproszono o zmianę adresu e-mail profilu");
    expect(email.text).toContain("„Anuluj zmianę”");
    // The way back without a link: the daily message's link, then the operator.
    expect(email.text).toContain("linkiem „Twój profil” z ostatniej codziennej wiadomości");
    expect(email.text).toContain(
      "Jeśli zmiana została już potwierdzona, napisz do operatora serwisu.\n",
    );
  });

  it("name CONTACT_EMAIL in the notice when it is set, still with no link", () => {
    const contact = "operator@example.invalid";
    const email = emailChangeNoticeEmail(OLD, contact);
    expect(email.text).toContain(
      `Jeśli zmiana została już potwierdzona, napisz do operatora serwisu: ${contact}.\n`,
    );
    expect(email.text).not.toMatch(/https?:|mailto:|\/dostep\/|\/potwierdz-email\//);
    expect(email.text).not.toContain(NEW);
  });
});

describe("createAccessMailer", () => {
  const db = createDatabase("postgres://radar:not-a-real-password@127.0.0.1:1/radar");
  afterAll(async () => {
    await db.destroy();
  });

  function setup(
    options: {
      sender?: "none" | "ok";
      fail?: (email: OutgoingEmail) => boolean;
      hold?: Promise<void>;
      maxPending?: number;
      closeDeadlineMs?: number;
      contactEmail?: string;
    } = {},
  ) {
    const lines: string[] = [];
    const sent: OutgoingEmail[] = [];
    const sender: EmailSender = {
      transport: "test",
      async send(email) {
        await options.hold;
        if (options.fail?.(email) === true) throw new EmailSendError("smtp_permanent", "permanent");
        sent.push(email);
      },
      close() {},
    };
    const mailer = createAccessMailer({
      db,
      sender: options.sender === "none" ? null : sender,
      publicBaseUrl: BASE,
      logger: createLogger("debug", (line) => lines.push(line)),
      ...(options.maxPending === undefined ? {} : { maxPending: options.maxPending }),
      ...(options.closeDeadlineMs === undefined
        ? {}
        : { closeDeadlineMs: options.closeDeadlineMs }),
      ...(options.contactEmail === undefined ? {} : { contactEmail: options.contactEmail }),
    });
    const logged = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    return { mailer, sent, lines, logged };
  }

  const change = { profileId: PROFILE_ID, currentEmail: OLD, newEmail: NEW, token: TOKEN };

  function expectNoSecrets(lines: readonly string[]) {
    for (const secret of [OLD, NEW, TOKEN, "not-a-real-password", "potwierdz-email"]) {
      expect(lines.join("")).not.toContain(secret);
    }
  }

  it("sends the notice, then the confirmation, after the call returns; logs ids only", async () => {
    const { mailer, sent, lines, logged } = setup();
    mailer.emailChange(change);
    expect(sent).toEqual([]);
    await until(() => sent.length === 2);
    expect(sent.map((email) => [email.to, email.subject])).toEqual([
      [OLD, EMAIL_CHANGE_NOTICE_SUBJECT],
      [NEW, EMAIL_CHANGE_SUBJECT],
    ]);
    await until(() => lines.length === 2);
    expect(
      logged().map(({ message, kind, outcome, profileId }) => ({
        message,
        kind,
        outcome,
        profileId,
      })),
    ).toEqual([
      {
        message: "access mail",
        kind: "email_change_notice",
        outcome: "sent",
        profileId: PROFILE_ID,
      },
      { message: "access mail", kind: "email_change", outcome: "sent", profileId: PROFILE_ID },
    ]);
    expectNoSecrets(lines);
    await mailer.close();
  });

  it("names CONTACT_EMAIL in the notice it sends when one is configured", async () => {
    const contact = "operator@example.invalid";
    const { mailer, sent, lines } = setup({ contactEmail: contact });
    mailer.emailChange(change);
    await until(() => sent.length === 2);
    expect(sent[0]?.text).toContain(`napisz do operatora serwisu: ${contact}.`);
    expect(sent[1]?.text).not.toContain(contact);
    expect(lines.join("")).not.toContain(contact);
    await mailer.close();
  });

  it("logs a failed send as a code with the profile id, and still sends the confirmation", async () => {
    const { mailer, sent, lines, logged } = setup({ fail: (email) => email.to === OLD });
    mailer.emailChange(change);
    await until(() => lines.length === 2);
    expect(sent.map((email) => email.to)).toEqual([NEW]);
    expect(logged()[0]).toMatchObject({
      level: "warn",
      message: "access mail",
      kind: "email_change_notice",
      outcome: "send_failed",
      profileId: PROFILE_ID,
      errorCode: "smtp_permanent",
      failureKind: "permanent",
    });
    expect(logged()[1]).toMatchObject({ kind: "email_change", outcome: "sent" });
    expectNoSecrets(lines);
    await mailer.close();
  });

  it("logs every request as not sent when e-mail is not configured, touching nothing", async () => {
    const { mailer, lines, logged } = setup({ sender: "none" });
    mailer.requestLoginLink(OLD);
    mailer.emailChange(change);
    expect(logged()).toMatchObject([
      { level: "warn", kind: "login_link", outcome: "not_sent", errorCode: "email_not_configured" },
      {
        level: "warn",
        kind: "email_change",
        outcome: "not_sent",
        errorCode: "email_not_configured",
      },
    ]);
    expectNoSecrets(lines);
    await mailer.close();
  });

  it("logs a database failure of a link request as codes only", async () => {
    const { mailer, sent, lines, logged } = setup();
    mailer.requestLoginLink(OLD);
    await until(() => lines.length === 1);
    expect(logged()[0]).toMatchObject({
      level: "error",
      message: "access mail",
      kind: "login_link",
      outcome: "failed",
      reason: "unreachable",
      code: "ECONNREFUSED",
    });
    expect(sent).toEqual([]);
    expectNoSecrets(lines);
    await mailer.close();
  });

  it("drops a request beyond the bound and the waiting ones at shutdown, logging codes", async () => {
    const held = gate();
    const { mailer, sent, lines, logged } = setup({ hold: held.opened, maxPending: 1 });
    mailer.emailChange(change);
    await delay(5);
    // The first job is running (held); one may wait, the next is dropped.
    mailer.emailChange(change);
    mailer.emailChange(change);
    expect(logged()).toMatchObject([
      {
        level: "warn",
        kind: "email_change",
        outcome: "dropped",
        errorCode: "access_mail_queue_full",
      },
    ]);
    const closing = mailer.close();
    held.open();
    await closing;
    expect(sent).toHaveLength(2);
    expect(logged().at(-1)).toMatchObject({
      level: "warn",
      outcome: "dropped",
      errorCode: "access_mail_shutdown",
      count: 1,
    });
    expectNoSecrets(lines);
  });

  it("logs a request refused because the queue is closed with its own code", async () => {
    const held = gate();
    const { mailer, logged, lines } = setup({ hold: held.opened });
    mailer.emailChange(change);
    await delay(5);
    const closing = mailer.close();
    mailer.requestLoginLink(OLD);
    expect(logged()).toEqual([
      expect.objectContaining({
        level: "warn",
        kind: "login_link",
        outcome: "dropped",
        errorCode: "access_mail_shutdown",
      }),
    ]);
    expect(logged()[0]).not.toHaveProperty("count");
    held.open();
    await closing;
    expect(lines.join("")).not.toContain("access_mail_queue_full");
    expectNoSecrets(lines);
  });

  it("gives up on a send that never ends at the shutdown deadline, logging it as dropped", async () => {
    const { mailer, sent, lines, logged } = setup({
      hold: new Promise<void>(() => undefined),
      closeDeadlineMs: 50,
    });
    mailer.emailChange(change);
    mailer.emailChange(change);
    await delay(5);
    const started = performance.now();
    await mailer.close();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(sent).toEqual([]);
    expect(logged()).toEqual([
      expect.objectContaining({
        level: "warn",
        outcome: "dropped",
        errorCode: "access_mail_shutdown",
        count: 1,
      }),
      expect.objectContaining({
        level: "warn",
        kind: "email_change",
        outcome: "dropped",
        errorCode: "access_mail_shutdown_timeout",
      }),
    ]);
    expectNoSecrets(lines);
  });

  it.each([
    ["is taken", false],
    ["fails", true],
  ])("starts no further send of the job it gave up on (the stuck send %s)", async (_, fails) => {
    const held = gate();
    const { mailer, sent, logged } = setup({
      hold: held.opened,
      closeDeadlineMs: 20,
      ...(fails ? { fail: () => true } : {}),
    });
    mailer.emailChange(change);
    await delay(5);
    await mailer.close();
    const before = logged().length;
    // The stuck notice ends after the shutdown: the confirmation is not sent.
    held.open();
    await delay(20);
    expect(sent.map((email) => email.to)).toEqual(fails ? [] : [OLD]);
    expect(logged().slice(before)).toEqual([
      expect.objectContaining({
        kind: "email_change_notice",
        outcome: fails ? "send_failed" : "sent",
      }),
    ]);
  });
});
