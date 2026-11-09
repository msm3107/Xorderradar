import type { Kysely } from "kysely";
import { requestLoginLink } from "../infrastructure/db/access-repository.js";
import { describeDatabaseFailure } from "../infrastructure/db/errors.js";
import type { Database } from "../infrastructure/db/schema.js";
import type { Logger } from "../infrastructure/logger.js";
import {
  emailChangeEmail,
  emailChangeNoticeEmail,
  loginLinkEmail,
} from "../notifications/access-emails.js";
import { EmailSendError, type EmailSender, type OutgoingEmail } from "../notifications/sender.js";
import { createMailQueue, type MailQueue } from "./mail-queue.js";

/**
 * The access e-mails of `serve` (D-031), sent after the response through the
 * bounded mail queue, each once (no retry: the customer can ask again, and
 * a resend could double a message the server took). Every outcome is one
 * „access mail” log line with the kind, the outcome and at most the profile
 * id and an error code — never an address, a token or a link.
 */

/** What an access e-mail is, in the log. */
export type AccessMailKind = "login_link" | "email_change" | "email_change_notice";

/** A saved address change: the notice goes to `currentEmail`, the confirmation to `newEmail`. */
export interface EmailChangeMail {
  readonly profileId: string;
  readonly currentEmail: string;
  readonly newEmail: string;
  readonly token: string;
}

export interface AccessMailer {
  /** „Wyślij mi link” for `email` (normalized): looked up, limited and sent after the response. */
  requestLoginLink(email: string): void;
  /** Sends the notice and the confirmation of a saved address change after the response. */
  emailChange(change: EmailChangeMail): void;
  /**
   * Drops the waiting work (logged) and resolves once the running job ended,
   * or after the shutdown deadline: then that job is logged as dropped and
   * abandoned — it starts no further send.
   */
  close(): Promise<void>;
}

/**
 * Longest wait of close() for the e-mail being sent. One SMTP send may wait
 * 50 s and more (SMTP_TIMEOUTS in sender.ts), a confirmation job two of them;
 * `serve` first gives open requests up to 10 s (SHUTDOWN_GRACE_MS), and
 * systemd kills it 20 s after SIGTERM (TimeoutStopSec, radar-serve.service).
 * 10 s + 5 s leaves the rest for closing the pool and the sender.
 */
export const MAIL_SHUTDOWN_DEADLINE_MS = 5_000;

export interface AccessMailerOptions {
  readonly db: Kysely<Database>;
  /** null: e-mail is not configured; every request is logged as not sent. */
  readonly sender: EmailSender | null;
  readonly publicBaseUrl: string;
  readonly logger: Logger;
  /** CONTACT_EMAIL, named in the notice to the old address; absent or null: not named. */
  readonly contactEmail?: string | null;
  /** Jobs waiting at most (tests). Default: MAIL_QUEUE_MAX_PENDING. */
  readonly maxPending?: number;
  /** close()'s wait for the running job (tests). Default: MAIL_SHUTDOWN_DEADLINE_MS. */
  readonly closeDeadlineMs?: number;
}

export function createAccessMailer(options: AccessMailerOptions): AccessMailer {
  const { db, sender, publicBaseUrl, logger } = options;
  const contactEmail = options.contactEmail ?? null;
  const queue: MailQueue = createMailQueue((error: unknown) => {
    // A job catches its own failures; reaching this is a bug, still logged as codes only.
    logger.error("access mail", { outcome: "failed", ...describeDatabaseFailure(error) });
  }, options.maxPending);
  /** The kind of the job running now, for the line of a job the shutdown abandons. */
  let running: AccessMailKind | null = null;
  /** Set when close() gave up on the running job: it must not start another send. */
  let abandoned = false;

  const enqueue = (kind: AccessMailKind, job: (sender: EmailSender) => Promise<void>): void => {
    if (sender === null) {
      logger.warn("access mail", {
        kind,
        outcome: "not_sent",
        errorCode: "email_not_configured",
      });
      return;
    }
    const queued = queue.push(async () => {
      running = kind;
      try {
        await job(sender);
      } finally {
        running = null;
      }
    });
    if (!queued) {
      logger.warn("access mail", {
        kind,
        outcome: "dropped",
        errorCode: queue.closed ? "access_mail_shutdown" : "access_mail_queue_full",
      });
    }
  };

  /** One send and its log line, `sent` or `send_failed`; a send failure is not rethrown. */
  const deliver = async (
    active: EmailSender,
    kind: AccessMailKind,
    profileId: string,
    email: OutgoingEmail,
  ): Promise<void> => {
    // Already logged as dropped by close(); the sender is being closed.
    if (abandoned) return;
    try {
      await active.send(email);
    } catch (error: unknown) {
      const failure =
        error instanceof EmailSendError ? error : new EmailSendError("send_failed", "permanent");
      logger.warn("access mail", {
        kind,
        outcome: "send_failed",
        profileId,
        errorCode: failure.code,
        failureKind: failure.kind,
      });
      return;
    }
    logger.info("access mail", { kind, outcome: "sent", profileId });
  };

  return {
    requestLoginLink(email) {
      enqueue("login_link", async (active) => {
        const request = await requestLoginLink(db, email).catch((error: unknown) => {
          logger.error("access mail", {
            kind: "login_link",
            outcome: "failed",
            ...describeDatabaseFailure(error),
          });
          return null;
        });
        if (request === null) return;
        if (request.kind === "no_profile") {
          logger.info("access mail", { kind: "login_link", outcome: "no_profile" });
          return;
        }
        if (request.kind === "limit_reached") {
          logger.info("access mail", {
            kind: "login_link",
            outcome: "limit_reached",
            profileId: request.profileId,
          });
          return;
        }
        await deliver(
          active,
          "login_link",
          request.profileId,
          loginLinkEmail(publicBaseUrl, request.email, request.link.token),
        );
      });
    },
    emailChange(change) {
      enqueue("email_change", async (active) => {
        // The notice first: the owner of the old address is warned even when the
        // confirmation fails or the shutdown gives up on the job during its send.
        await deliver(
          active,
          "email_change_notice",
          change.profileId,
          emailChangeNoticeEmail(change.currentEmail, contactEmail),
        );
        // The confirmation also when the notice failed: the change is saved either
        // way, and an old mailbox that refuses mail is a common reason for a change.
        await deliver(
          active,
          "email_change",
          change.profileId,
          emailChangeEmail(publicBaseUrl, change.newEmail, change.token),
        );
      });
    },
    async close() {
      const { dropped, timedOut } = await queue.close(
        options.closeDeadlineMs ?? MAIL_SHUTDOWN_DEADLINE_MS,
      );
      if (dropped > 0) {
        logger.warn("access mail", {
          outcome: "dropped",
          errorCode: "access_mail_shutdown",
          count: dropped,
        });
      }
      if (timedOut) {
        abandoned = true;
        logger.warn("access mail", {
          ...(running === null ? {} : { kind: running }),
          outcome: "dropped",
          errorCode: "access_mail_shutdown_timeout",
        });
      }
    },
  };
}
