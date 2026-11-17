import { queryOne, type DbExecutor } from "../db/connection.ts";
import type { EnvSource } from "../utils/env.ts";

/** Persist the next wake-up in the Worker without polling an idle database. */
export async function scheduleCloudflareWebhookRetry(
  database: DbExecutor,
  env: EnvSource,
  send: typeof fetch = fetch,
): Promise<void> {
  const url = env.CLOUDFLARE_WEBHOOK_SCHEDULER_URL;
  const token = env.CLOUDFLARE_WEBHOOK_SCHEDULER_TOKEN;
  if (!url || !token) return;
  const next = await queryOne<{ at: number | null }>(
    database,
    `
    SELECT min(greatest(d.next_attempt_at, coalesce(d.locked_until, 0))) AS at
    FROM webhook_deliveries d
    JOIN webhook_endpoints e ON e.id = d.endpoint_id
    WHERE d.status = 'pending' AND e.enabled
  `,
  );
  if (next?.at == null) return;
  const response = await send(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      at: Math.max(Number(next.at) * 1000, Date.now() + 1000),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  if (!response.ok)
    throw new Error(`Webhook scheduler returned ${response.status}.`);
}
