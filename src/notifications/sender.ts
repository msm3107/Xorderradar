import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTransport } from "nodemailer";
import type { EmailAddress, EmailConfig, SmtpServer } from "../infrastructure/config.js";
import type { DeliveryTransport } from "../infrastructure/db/schema.js";

/** One e-mail to one recipient. Headers are built by nodemailer, never by hand. */
export interface OutgoingEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** Delivers e-mails over one transport (D-010). Injected into the CLI, so tests never send. */
export interface EmailSender {
  readonly transport: DeliveryTransport;
  /** Resolves once the e-mail is accepted (written, or taken by the SMTP server); else EmailSendError. */
  send(email: OutgoingEmail): Promise<void>;
  close(): void;
}

/**
 * What a failed send means for the delivery and the run (D-024):
 * - `transient`: this message was certainly not taken, but may be later (a
 *   4xx reply to MAIL FROM, RCPT TO or DATA) — retried within the run, then
 *   recorded as failed (one attempt spent);
 * - `permanent`: this message was certainly refused (a 5xx reply to RCPT TO
 *   or DATA, anything unrecognised) — recorded as failed (one attempt spent),
 *   retried by later runs until the attempt limit;
 * - `unreachable`: the server could not be reached (DNS, connection refused,
 *   no greeting, a 4xx greeting) or is closing the session (421 at any stage) —
 *   retried within the run; if it persists, the run stops: nothing is about
 *   the message, so no attempt is spent;
 * - `setup`: the configuration or the server refuses every message (login,
 *   TLS or STARTTLS, a 5xx greeting or MAIL FROM, an unwritable outbox) —
 *   never retried; the run stops without spending attempts;
 * - `uncertain`: the connection broke without a reply, possibly after the
 *   server took the message — never resent (at-most-once); the claimed rows
 *   stay pending for the operator and the run stops.
 */
export type SendFailureKind = "transient" | "permanent" | "unreachable" | "setup" | "uncertain";

export class EmailSendError extends Error {
  override readonly name = "EmailSendError";

  constructor(
    /** A short machine code (deliveries_error_code_check), never a server message. */
    readonly code: string,
    readonly kind: SendFailureKind,
  ) {
    super(`E-mail not sent (${code}, ${kind})`);
  }
}

/** A code safe to store: lower case, `[a-z0-9_]`, at most 64 characters. */
function errorCode(prefix: string, value: string): string {
  const code = `${prefix}_${value.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`;
  return code.slice(0, 64);
}

/**
 * Failures that can only happen before a connection exists (no DNS answer,
 * refused, no greeting, no TLS upgrade in time): nothing can have been sent.
 * EHOSTUNREACH and ENETUNREACH are not here: nodemailer reports them as
 * ESOCKET whether they come at connect time or mid-session, so they are
 * `uncertain` like any other broken connection.
 */
const NOT_CONNECTED_CODES = new Set(["EDNS", "ECONNREFUSED"]);
const NOT_CONNECTED_TIMEOUTS = new Set(["CONNECT_TIMEOUT", "GREETING_TIMEOUT", "UPGRADE_TIMEOUT"]);
const NO_REPLY_CODES = new Set([
  "ECONNECTION",
  "ESOCKET",
  "ETIMEDOUT",
  "ECONNRESET",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);
/** nodemailer codes of a refused login or missing credentials. */
const AUTH_CODES = new Set(["EAUTH", "ENOAUTH", "EOAUTH2"]);
/**
 * Node TLS handshake errors (an implicit-TLS connection reports them as
 * ESOCKET with this `originalCode`): certificate verification and protocol
 * version mismatches, which happen before anything is sent. Record-layer
 * errors (possible mid-session) are deliberately not here.
 */
const TLS_HANDSHAKE_CODE =
  /^(?:CERT_[A-Z_]+|UNABLE_TO_[A-Z_]+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|INVALID_CA|HOSTNAME_MISMATCH|ERR_TLS_CERT_ALTNAME_INVALID|ERR_SSL_WRONG_VERSION_NUMBER|ERR_SSL_UNSUPPORTED_PROTOCOL|ERR_SSL_NO_PROTOCOLS_AVAILABLE|ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION)$/;
/**
 * Greeting commands (nodemailer's `command`): a reply to them refuses the
 * session itself, whatever the code (with STARTTLS required, nodemailer
 * reports a refused EHLO as ECONNECTION).
 */
const HELLO_COMMANDS = new Set(["EHLO", "HELO", "LHLO"]);

function field(error: object, name: string): unknown {
  return (error as Record<string, unknown>)[name];
}

function text(error: object, name: string): string | undefined {
  const value = field(error, name);
  return typeof value === "string" ? value : undefined;
}

/**
 * Classifies a nodemailer error by its `responseCode`, `code`, `originalCode`,
 * `timeoutType` and `command` (the SMTP stage) only — the message and the
 * server's reply text (which may echo an address) are never read or stored.
 */
export function classifySmtpError(error: unknown): EmailSendError {
  if (typeof error !== "object" || error === null)
    return new EmailSendError("send_failed", "permanent");
  const rawResponseCode = field(error, "responseCode");
  const responseCode =
    typeof rawResponseCode === "number" && Number.isInteger(rawResponseCode)
      ? rawResponseCode
      : null;
  const code = text(error, "code");
  const originalCode = text(error, "originalCode");
  const timeoutType = text(error, "timeoutType");
  const command = text(error, "command");
  const codes = [code, originalCode].filter((value) => value !== undefined);
  const shown = responseCode === null ? (originalCode ?? code) : String(responseCode);
  if (shown === undefined) return new EmailSendError("send_failed", "permanent");
  const result = (kind: SendFailureKind) => new EmailSendError(errorCode("smtp", shown), kind);

  // Login and TLS (incl. a refused STARTTLS: ETLS with 454/530) fail for every message alike.
  if (codes.some((value) => AUTH_CODES.has(value)) || command?.startsWith("AUTH") === true)
    return result("setup");
  if (code === "ETLS" || codes.some((value) => TLS_HANDSHAKE_CODE.test(value)))
    return result("setup");

  if (responseCode !== null) {
    const temporary = responseCode >= 400 && responseCode < 500;
    // 421 (RFC 5321 4.2): the server is closing the session, at whatever stage.
    if (responseCode === 421) return result("unreachable");
    // A refused greeting or EHLO/HELO/LHLO: the server takes no session at all. At CONN only
    // EPROTOCOL (the greeting): a reply left over when the connection closed (ECONNECTION,
    // also command CONN) may answer the message itself, so it is classified by its code below.
    const refusedSession =
      (command !== undefined && HELLO_COMMANDS.has(command)) ||
      (command === "CONN" && code === "EPROTOCOL");
    if (refusedSession) return result(temporary ? "unreachable" : "setup");
    // The sender refused: the configured EMAIL_FROM, not this message.
    if (command === "MAIL FROM") return result(temporary ? "transient" : "setup");
    // RCPT TO, DATA, a reply at close or an unknown stage: about this message and recipient.
    return result(temporary ? "transient" : "permanent");
  }
  if (
    codes.some((value) => NOT_CONNECTED_CODES.has(value)) ||
    (timeoutType !== undefined && NOT_CONNECTED_TIMEOUTS.has(timeoutType))
  ) {
    return result("unreachable");
  }
  if (codes.some((value) => NO_REPLY_CODES.has(value))) return result("uncertain");
  return result("permanent");
}

/**
 * Writes `files` in order, each created exclusively and owner-only; if one
 * fails, the ones already written are removed (best effort), so a later
 * retry of the same e-mail does not leave a stray copy behind.
 */
export async function writeAllOrNothing(
  files: readonly { readonly path: string; readonly data: string | Buffer }[],
): Promise<void> {
  const written: string[] = [];
  try {
    for (const file of files) {
      await writeFile(file.path, file.data, { flag: "wx", mode: 0o600 });
      written.push(file.path);
    }
  } catch (error: unknown) {
    await Promise.all(written.map((path) => rm(path, { force: true }).catch(() => undefined)));
    throw error;
  }
}

/** Options every transport gets: no file or URL content in a message, one recipient. */
const MESSAGE_LIMITS = { disableFileAccess: true, disableUrlAccess: true } as const;

function message(from: EmailAddress, email: OutgoingEmail) {
  return {
    from: { name: from.name, address: from.address },
    // An object, not a string: nodemailer does not parse it for more recipients.
    to: { name: "", address: email.to },
    subject: email.subject,
    text: email.text,
    html: email.html,
  };
}

/**
 * `test` mode: every e-mail becomes `<time>-<uuid>.eml` (the full MIME
 * message, as it would be sent) and `<time>-<uuid>.json` (the same content,
 * readable) in `outboxDir`. File names never contain message data; files are
 * created exclusively (`wx`) and readable by the owner only. Nothing is sent.
 */
export function createOutboxSender(config: {
  readonly outboxDir: string;
  readonly from: EmailAddress;
}): EmailSender {
  const transporter = createTransport({
    streamTransport: true,
    buffer: true,
    newline: "unix",
    ...MESSAGE_LIMITS,
  });
  return {
    transport: "test",
    async send(email) {
      try {
        const info = await transporter.sendMail(message(config.from, email));
        if (!Buffer.isBuffer(info.message)) throw new Error("stream transport returned no buffer");
        await mkdir(config.outboxDir, { recursive: true, mode: 0o700 });
        const base = join(
          config.outboxDir,
          `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`,
        );
        const readable = {
          from: config.from,
          to: email.to,
          subject: email.subject,
          text: email.text,
          html: email.html,
        };
        await writeAllOrNothing([
          { path: `${base}.eml`, data: info.message },
          { path: `${base}.json`, data: `${JSON.stringify(readable, null, 2)}\n` },
        ]);
      } catch {
        // An unwritable outbox fails every e-mail alike.
        throw new EmailSendError("outbox_write_failed", "setup");
      }
    },
    close() {
      transporter.close();
    },
  };
}

/** Bounds of one SMTP send: every wait is limited, so a stuck server cannot hang the run. */
export const SMTP_TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 30_000,
  dnsTimeout: 10_000,
} as const;

/**
 * `smtp` mode: sends through the configured server. TLS always: implicit
 * (smtps) or STARTTLS that must succeed before anything else is sent
 * (`requireTLS`, so credentials never travel in plaintext); certificates are
 * verified, TLS 1.2 at least. nodemailer's own logging is off (it would log
 * addresses).
 */
export function createSmtpSender(config: {
  readonly smtp: SmtpServer;
  readonly from: EmailAddress;
}): EmailSender {
  const { smtp } = config;
  const transporter = createTransport({
    host: smtp.host,
    port: smtp.port ?? (smtp.implicitTls ? 465 : 587),
    secure: smtp.implicitTls,
    requireTLS: !smtp.implicitTls,
    ...(smtp.user === null || smtp.password === null
      ? {}
      : { auth: { user: smtp.user, pass: smtp.password } }),
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    ...SMTP_TIMEOUTS,
    logger: false,
    debug: false,
    maxRecipients: 1,
    ...MESSAGE_LIMITS,
  });
  return {
    transport: "smtp",
    async send(email) {
      try {
        await transporter.sendMail(message(config.from, email));
      } catch (error: unknown) {
        throw classifySmtpError(error);
      }
    },
    close() {
      transporter.close();
    },
  };
}

/** The sender for the configured mode. */
export function createEmailSender(config: EmailConfig): EmailSender {
  return config.mode === "test" ? createOutboxSender(config) : createSmtpSender(config);
}

/** Pauses between in-run retries of a transient or unreachable failure (so at most 3 tries). */
export const RETRY_DELAYS_MS = [2_000, 10_000] as const;

export type SendResult =
  { readonly ok: true } | { readonly ok: false; readonly error: EmailSendError };

/** Kinds worth another try within the run. */
const RETRIED_KINDS: ReadonlySet<SendFailureKind> = new Set(["transient", "unreachable"]);

/**
 * Sends once, retrying only `transient` and `unreachable` failures after each of `delaysMs`.
 * Stops retrying when `signal` is aborted (the run lost its lock).
 */
export async function sendWithRetry(
  sender: EmailSender,
  email: OutgoingEmail,
  options: {
    readonly sleep: (ms: number) => Promise<void>;
    readonly signal: AbortSignal;
    readonly delaysMs?: readonly number[];
  },
): Promise<SendResult> {
  const delays = options.delaysMs ?? RETRY_DELAYS_MS;
  // A function, so the check is not narrowed away across the awaits.
  const aborted = (): boolean => options.signal.aborted;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await sender.send(email);
      return { ok: true };
    } catch (error: unknown) {
      const failure =
        error instanceof EmailSendError ? error : new EmailSendError("send_failed", "permanent");
      const delay = delays[attempt];
      if (!RETRIED_KINDS.has(failure.kind) || delay === undefined || aborted()) {
        return { ok: false, error: failure };
      }
      await options.sleep(delay);
      if (aborted()) return { ok: false, error: failure };
    }
  }
}
