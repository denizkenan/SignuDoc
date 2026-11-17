import { createHash } from "node:crypto";

import { getDb, queryOne, type DbExecutor } from "../db/connection.ts";

// Idempotency-Key for the API's create and send calls. The first request
// with a key reserves it; when it finishes, its response is kept for 24
// hours and a retry with the same key and the same request gets that
// response again. A different request under the same key is refused, and
// a retry while the first is still running is told to wait.

export const IDEMPOTENCY_WINDOW_SECONDS = 24 * 60 * 60;

export type IdempotencyClaim =
  | { kind: "new" }
  | { kind: "replay"; response: unknown; statusCode: number }
  | { kind: "recover"; resourceId: string }
  | { kind: "in_progress" }
  | { kind: "mismatch" };

export function readIdempotencyKey(
  headers: Headers,
): string | null | undefined {
  const value = headers.get("idempotency-key");

  if (value === null) {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length >= 1 && trimmed.length <= 255 ? trimmed : undefined;
}

/** A fingerprint of what was asked: the route and the request body. */
export function hashRequest(route: string, body: Uint8Array | string): string {
  return createHash("sha256")
    .update(route)
    .update("\n")
    .update(body)
    .digest("hex");
}

/** Reserves the key for this request, or says what happened to it before. */
export async function claimIdempotencyKey(
  input: { apiKeyId: string; key: string; requestHash: string },
  database: DbExecutor = getDb(),
  now: number = Math.floor(Date.now() / 1000),
): Promise<IdempotencyClaim> {
  // A reservation older than the window is forgotten, so the key can be
  // used again.
  await database.query(
    `
      DELETE FROM api_idempotency
      WHERE api_key_id = $1 AND idempotency_key = $2 AND created_at <= $3
    `,
    [input.apiKeyId, input.key, now - IDEMPOTENCY_WINDOW_SECONDS],
  );

  const inserted = await database.query(
    `
      INSERT INTO api_idempotency (api_key_id, idempotency_key, request_hash, created_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT DO NOTHING
    `,
    [input.apiKeyId, input.key, input.requestHash, now],
  );

  if ((inserted.rowCount ?? 0) === 1) {
    return { kind: "new" };
  }

  const existing = await queryOne<{
    requestHash: string;
    resourceId: string | null;
    response: unknown;
    statusCode: number | null;
  }>(
    database,
    `
      SELECT request_hash AS "requestHash", status_code AS "statusCode",
        response, resource_id AS "resourceId"
      FROM api_idempotency
      WHERE api_key_id = $1 AND idempotency_key = $2
    `,
    [input.apiKeyId, input.key],
  );

  if (!existing) {
    // Deleted between the two statements: treat it as new next time.
    return { kind: "in_progress" };
  }

  if (existing.requestHash !== input.requestHash) {
    return { kind: "mismatch" };
  }

  if (existing.statusCode === null) {
    // The first request made its envelope and then failed, or is still
    // finishing: either way the answer is that envelope.
    return existing.resourceId
      ? { kind: "recover", resourceId: existing.resourceId }
      : { kind: "in_progress" };
  }

  return {
    kind: "replay",
    response: existing.response,
    statusCode: existing.statusCode,
  };
}

/** Keeps the response for retries. */
export async function completeIdempotencyKey(
  input: {
    apiKeyId: string;
    key: string;
    response: unknown;
    statusCode: number;
  },
  database: DbExecutor = getDb(),
) {
  await database.query(
    `
      UPDATE api_idempotency
      SET status_code = $3, response = $4
      WHERE api_key_id = $1 AND idempotency_key = $2
    `,
    [
      input.apiKeyId,
      input.key,
      input.statusCode,
      JSON.stringify(input.response),
    ],
  );
}

/**
 * Notes what the request has made, as soon as it has made it, so a later
 * failure cannot lead a retry to make it again.
 */
export async function rememberIdempotentResource(
  input: { apiKeyId: string; key: string; resourceId: string },
  database: DbExecutor = getDb(),
) {
  await database.query(
    `
      UPDATE api_idempotency
      SET resource_id = $3
      WHERE api_key_id = $1 AND idempotency_key = $2
    `,
    [input.apiKeyId, input.key, input.resourceId],
  );
}

/**
 * Lets the key go after a failure that a retry might not repeat (the
 * install had a problem), so the retry runs for real.
 */
export async function releaseIdempotencyKey(
  input: { apiKeyId: string; key: string },
  database: DbExecutor = getDb(),
) {
  await database.query(
    `DELETE FROM api_idempotency WHERE api_key_id = $1 AND idempotency_key = $2`,
    [input.apiKeyId, input.key],
  );
}

/** For the daily cleanup. */
export async function deleteExpiredIdempotencyKeys(
  database: DbExecutor = getDb(),
  now: number = Math.floor(Date.now() / 1000),
): Promise<number> {
  const result = await database.query(
    `DELETE FROM api_idempotency WHERE created_at <= $1`,
    [now - IDEMPOTENCY_WINDOW_SECONDS],
  );

  return result.rowCount ?? 0;
}
