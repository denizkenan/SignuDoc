import { randomUUID } from "node:crypto";

import { waitUntil } from "@vercel/functions";

import { getApiEnvelopeWithOwner } from "../api/envelope-view.ts";
import {
  getDb,
  queryMany,
  queryOne,
  type DbExecutor,
} from "../db/connection.ts";
import { isMissingSchemaError } from "../settings.ts";
import type { EnvSource } from "../utils/env.ts";
import { signingSecretsFor } from "./endpoints.ts";
import { WEBHOOK_TEST_EVENT } from "./events.ts";
import { postWebhook, type WebhookPostResult } from "./safe-post.ts";
import { webhookHeaders } from "./signing.ts";

// Sending deliveries. A drain claims the deliveries that are due, sends
// them, and records what happened: delivered on a 2xx answer, otherwise a
// next try on the schedule below, until the last try fails for good.
//
// Three things start a drain, all inside Vercel: a change that queued a
// delivery (kept alive with waitUntil), any later API request, and
// the daily cron (see /api/internal/webhooks). On Hobby, with no traffic,
// a retry can therefore wait until the next day.

/** Seconds to wait after try 1, 2, ... before the next. */
export const RETRY_DELAYS_SECONDS = [
  60,
  5 * 60,
  30 * 60,
  2 * 60 * 60,
  8 * 60 * 60,
  24 * 60 * 60,
  24 * 60 * 60,
] as const;
/** Tries in all: the first, then one after each delay. */
export const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1;
const BATCH_SIZE = 25;
const PARALLEL_SENDS = 5;
/** How long one drain may hold a delivery before another may take it. */
const LEASE_SECONDS = 60;
const MAX_ERROR_LENGTH = 500;

/** When to try again after `attempts` tries, or null to give up. */
export function nextAttemptAt(attempts: number, now: number): number | null {
  const delay = RETRY_DELAYS_SECONDS[attempts - 1];

  return delay === undefined ? null : now + delay;
}

export type WebhookPayload = {
  data: Record<string, unknown>;
  timestamp: string;
  type: string;
};

type ClaimedDelivery = {
  attempts: number;
  auditEventId: string | null;
  auditCreatedAt: number | null;
  auditMetadata: Record<string, unknown> | null;
  createdAt: number;
  envelopeId: string | null;
  eventType: string;
  id: string;
  /**
   * The lease this drain took. Every write about this try checks it is
   * still the one on the row, so a try that outlived its lease (and was
   * taken over by a newer drain) cannot overwrite what the newer one did.
   */
  lockedUntil: number;
  /** The body exactly as first sent, or null before the first try. */
  payload: string | null;
  previousSecretEncrypted: string | null;
  previousSecretExpiresAt: number | null;
  secretEncrypted: string;
  signerId: string | null;
  url: string;
};

function nowInSeconds() {
  return Math.floor(Date.now() / 1000);
}

/**
 * What a delivery says, built from the envelope as it is now. Null when
 * the envelope has since been deleted, so there is nothing left to say.
 */
export async function buildWebhookPayload(
  delivery: Pick<
    ClaimedDelivery,
    | "auditCreatedAt"
    | "auditMetadata"
    | "createdAt"
    | "envelopeId"
    | "eventType"
    | "signerId"
  >,
  database: DbExecutor = getDb(),
): Promise<WebhookPayload | null> {
  if (!delivery.envelopeId) {
    return null;
  }

  const found = await getApiEnvelopeWithOwner(delivery.envelopeId, database);

  if (!found) {
    return null;
  }

  const data: Record<string, unknown> = {
    envelope: found.envelope,
    owner: found.owner,
  };

  if (delivery.signerId) {
    data.signer =
      found.envelope.signers.find(
        (signer) => signer.id === delivery.signerId,
      ) ?? null;
  }

  const reason = delivery.auditMetadata?.reason;

  if (typeof reason === "string" && reason.length > 0) {
    data.reason = reason;
  }

  return {
    data,
    timestamp: new Date(
      (delivery.auditCreatedAt ?? delivery.createdAt) * 1000,
    ).toISOString(),
    type: delivery.eventType,
  };
}

/** Takes up to `limit` due deliveries for this drain alone. */
async function claimDueDeliveries(
  database: DbExecutor,
  now: number,
  limit: number,
  onlyId?: string,
): Promise<ClaimedDelivery[]> {
  return queryMany<ClaimedDelivery>(
    database,
    `
      WITH due AS (
        SELECT d.id
        FROM webhook_deliveries d
        JOIN webhook_endpoints e ON e.id = d.endpoint_id
        WHERE d.status = 'pending'
          AND d.next_attempt_at <= $1
          AND (d.locked_until IS NULL OR d.locked_until <= $1)
          AND e.enabled
          AND ($4::text IS NULL OR d.id = $4)
        ORDER BY d.next_attempt_at, d.id
        LIMIT $2
        FOR UPDATE OF d SKIP LOCKED
      ),
      claimed AS (
        UPDATE webhook_deliveries d
        SET locked_until = $1 + $3, attempts = d.attempts + 1, updated_at = $1
        FROM due
        WHERE d.id = due.id
        RETURNING d.*
      )
      SELECT
        c.id,
        c.event_type AS "eventType",
        c.envelope_id AS "envelopeId",
        c.audit_event_id AS "auditEventId",
        c.signer_id AS "signerId",
        c.payload,
        c.attempts,
        c.locked_until AS "lockedUntil",
        c.created_at AS "createdAt",
        a.created_at AS "auditCreatedAt",
        a.metadata AS "auditMetadata",
        e.url,
        e.secret_encrypted AS "secretEncrypted",
        e.previous_secret_encrypted AS "previousSecretEncrypted",
        e.previous_secret_expires_at AS "previousSecretExpiresAt"
      FROM claimed c
      JOIN webhook_endpoints e ON e.id = c.endpoint_id
      LEFT JOIN audit_events a ON a.id = c.audit_event_id
      ORDER BY c.next_attempt_at, c.id
    `,
    [now, limit, LEASE_SECONDS, onlyId ?? null],
  );
}

function describeFailure(result: WebhookPostResult): string {
  if (result.status === null) {
    return result.error;
  }

  const body = result.body.trim();

  return `Answered ${String(result.status)}${body ? `: ${body}` : ""}`;
}

async function recordOutcome(
  database: DbExecutor,
  delivery: ClaimedDelivery,
  outcome:
    | { kind: "delivered"; status: number }
    | { error: string; kind: "failed"; status: number | null }
    | { kind: "dropped"; reason: string },
  now: number,
) {
  if (outcome.kind === "delivered") {
    await database.query(
      `
        UPDATE webhook_deliveries
        SET status = 'delivered', delivered_at = $2, last_status_code = $3,
            last_error = NULL, locked_until = NULL, next_attempt_at = NULL,
            updated_at = $2
        WHERE id = $1 AND locked_until = $4 AND status = 'pending'
      `,
      [delivery.id, now, outcome.status, delivery.lockedUntil],
    );
    return;
  }

  if (outcome.kind === "dropped") {
    await database.query(
      `
        UPDATE webhook_deliveries
        SET status = 'failed', last_error = $3, locked_until = NULL,
            next_attempt_at = NULL, updated_at = $2
        WHERE id = $1 AND locked_until = $4 AND status = 'pending'
      `,
      [delivery.id, now, outcome.reason, delivery.lockedUntil],
    );
    return;
  }

  const next = nextAttemptAt(delivery.attempts, now);

  await database.query(
    `
      UPDATE webhook_deliveries
      SET status = $3, next_attempt_at = $4, last_status_code = $5,
          last_error = $6, locked_until = NULL, updated_at = $2
      WHERE id = $1 AND locked_until = $7 AND status = 'pending'
    `,
    [
      delivery.id,
      now,
      next === null ? "failed" : "pending",
      next,
      outcome.status,
      outcome.error.slice(0, MAX_ERROR_LENGTH),
      delivery.lockedUntil,
    ],
  );
}

async function envelopeExists(
  delivery: ClaimedDelivery,
  database: DbExecutor,
): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    database,
    `SELECT id FROM envelopes WHERE id = $1`,
    [delivery.envelopeId],
  );

  return row !== null;
}

async function sendOne(
  database: DbExecutor,
  delivery: ClaimedDelivery,
  env: EnvSource,
): Promise<"delivered" | "failed" | "dropped" | "skipped"> {
  let body = delivery.payload;

  // Checked before every try, the first and each retry: its event was
  // taken back (a send whose invitation could not go out), or its
  // envelope is gone. Either way there is nothing true left to tell.
  if (delivery.auditEventId && delivery.auditCreatedAt === null) {
    await recordOutcome(
      database,
      delivery,
      { kind: "dropped", reason: "The change it reported was undone." },
      nowInSeconds(),
    );
    return "dropped";
  }

  if (delivery.envelopeId && !(await envelopeExists(delivery, database))) {
    await recordOutcome(
      database,
      delivery,
      { kind: "dropped", reason: "The envelope was deleted." },
      nowInSeconds(),
    );
    return "dropped";
  }

  if (body === null) {
    const payload = await buildWebhookPayload(delivery, database);

    if (!payload) {
      await recordOutcome(
        database,
        delivery,
        { kind: "dropped", reason: "The envelope was deleted." },
        nowInSeconds(),
      );
      return "dropped";
    }

    body = JSON.stringify(payload);

    // Kept, so every later try sends, and signs, the same bytes. Only
    // while this drain still holds the lease: if it lost it, the newer
    // drain sends instead.
    const saved = await database.query(
      `
        UPDATE webhook_deliveries SET payload = $2
        WHERE id = $1 AND locked_until = $3 AND payload IS NULL
      `,
      [delivery.id, body, delivery.lockedUntil],
    );

    if ((saved.rowCount ?? 0) === 0) {
      return "skipped";
    }
  }

  const sentAt = nowInSeconds();
  const secrets = signingSecretsFor(delivery, sentAt, env);

  if (secrets.length === 0) {
    await recordOutcome(
      database,
      delivery,
      {
        error:
          "The signing secret can no longer be read (the auth secret changed). Rotate the endpoint's secret in Settings.",
        kind: "failed",
        status: null,
      },
      sentAt,
    );
    return "failed";
  }

  const result = await postWebhook(
    delivery.url,
    {
      body,
      headers: webhookHeaders(secrets, {
        body,
        id: delivery.id,
        timestamp: sentAt,
      }),
    },
    { env },
  );
  const finishedAt = nowInSeconds();

  if (result.ok) {
    await recordOutcome(
      database,
      delivery,
      { kind: "delivered", status: result.status },
      finishedAt,
    );
    return "delivered";
  }

  await recordOutcome(
    database,
    delivery,
    { error: describeFailure(result), kind: "failed", status: result.status },
    finishedAt,
  );
  return "failed";
}

export type DrainSummary = {
  delivered: number;
  dropped: number;
  failed: number;
  /** Tries that lost their lease to a newer drain, which sends instead. */
  skipped: number;
};

/**
 * Sends what is due, a batch at a time, a few at once. Stops after
 * `maxBatches` so one function never runs for long.
 */
export async function drainWebhookDeliveries(
  options: {
    database?: DbExecutor;
    env?: EnvSource;
    maxBatches?: number;
    onlyId?: string;
  } = {},
): Promise<DrainSummary> {
  const database = options.database ?? getDb();
  const env = options.env ?? process.env;
  const summary: DrainSummary = {
    delivered: 0,
    dropped: 0,
    failed: 0,
    skipped: 0,
  };

  for (let batch = 0; batch < (options.maxBatches ?? 4); batch += 1) {
    const claimed = await claimDueDeliveries(
      database,
      nowInSeconds(),
      BATCH_SIZE,
      options.onlyId,
    );

    if (claimed.length === 0) {
      break;
    }

    for (let start = 0; start < claimed.length; start += PARALLEL_SENDS) {
      const results = await Promise.all(
        claimed.slice(start, start + PARALLEL_SENDS).map((delivery) =>
          sendOne(database, delivery, env).catch((error: unknown) => {
            console.error(
              `[webhooks] Sending delivery ${delivery.id} failed:`,
              error,
            );
            return "failed" as const;
          }),
        ),
      );

      for (const result of results) {
        summary[result] += 1;
      }
    }

    if (claimed.length < BATCH_SIZE) {
      break;
    }
  }

  return summary;
}

/** Whether anything is waiting, so callers can skip a drain cheaply. */
export async function hasDueWebhookDeliveries(
  database: DbExecutor = getDb(),
  now: number = nowInSeconds(),
): Promise<boolean> {
  try {
    const row = await queryOne<{ due: boolean }>(
      database,
      `
        SELECT EXISTS (
          SELECT 1 FROM webhook_deliveries
          WHERE status = 'pending' AND next_attempt_at <= $1
            AND (locked_until IS NULL OR locked_until <= $1)
        ) AS due
      `,
      [now],
    );

    return row?.due ?? false;
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return false;
    }

    throw error;
  }
}

async function drainQuietly() {
  try {
    await drainWebhookDeliveries();
  } catch (error) {
    console.error("[webhooks] Sending deliveries failed:", error);
  }
}

/**
 * Starts sending due deliveries without holding up the response.
 * waitUntil keeps a Vercel function alive until it is done; on a server
 * that stays up it is not needed, and the work simply runs.
 */
export function scheduleWebhookDrain() {
  waitUntil(drainQuietly());
}

/** Like scheduleWebhookDrain, but only when something is due. */
export function scheduleWebhookDrainIfDue() {
  waitUntil(
    (async () => {
      if (await hasDueWebhookDeliveries().catch(() => false)) {
        await drainQuietly();
      }
    })(),
  );
}

/**
 * Queues a webhook.test delivery for one endpoint and sends it at once.
 * Returns the delivery as it ended up.
 */
export async function sendTestWebhook(
  endpointId: string,
  options: { database?: DbExecutor; env?: EnvSource } = {},
): Promise<{
  id: string;
  lastError: string | null;
  lastStatusCode: number | null;
  status: string;
}> {
  const database = options.database ?? getDb();
  const now = nowInSeconds();
  const id = `msg_${randomUUID().replaceAll("-", "")}`;
  const payload: WebhookPayload = {
    data: { message: "A test event from SignuDoc. No envelope changed." },
    timestamp: new Date(now * 1000).toISOString(),
    type: WEBHOOK_TEST_EVENT,
  };

  await database.query(
    `
      INSERT INTO webhook_deliveries (
        id, endpoint_id, event_type, payload, status, attempts,
        next_attempt_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'pending', $5, $6, $6, $6)
    `,
    // A test is tried once: it starts as if it were on its last try.
    [
      id,
      endpointId,
      WEBHOOK_TEST_EVENT,
      JSON.stringify(payload),
      MAX_ATTEMPTS - 1,
      now,
    ],
  );
  await drainWebhookDeliveries({
    database,
    env: options.env,
    maxBatches: 1,
    onlyId: id,
  });

  const row = await queryOne<{
    id: string;
    lastError: string | null;
    lastStatusCode: number | null;
    status: string;
  }>(
    database,
    `
      SELECT id, status, last_status_code AS "lastStatusCode", last_error AS "lastError"
      FROM webhook_deliveries WHERE id = $1
    `,
    [id],
  );

  return (
    row ?? {
      id,
      lastError: "Not sent.",
      lastStatusCode: null,
      status: "failed",
    }
  );
}
