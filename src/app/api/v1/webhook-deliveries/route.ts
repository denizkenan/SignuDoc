import { z } from "zod";

import { describeZodError } from "@/lib/api/envelopes";
import { apiError, apiJson } from "@/lib/api/http";
import { handleApi } from "@/lib/api/route";
import { webhookEventTypes } from "@/lib/webhooks/events";
import { listApiWebhookDeliveries } from "@/lib/webhooks/log";

// Webhook deliveries, newest first, with what each one carried. For an app
// that was down and wants to catch up: the payloads are the same ones its
// endpoint was sent. Deliveries are kept 30 days once delivered, 90 if not.

const querySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  since: z
    .string()
    .datetime({ offset: true })
    .transform((value) => Math.floor(Date.parse(value) / 1000))
    .optional(),
  status: z.enum(["delivered", "failed", "pending"]).optional(),
  type: z.enum(webhookEventTypes).optional(),
});

export async function GET(request: Request) {
  return handleApi(
    request,
    "read",
    "api_webhook_deliveries_failure",
    async () => {
      const url = new URL(request.url);
      const query = querySchema.safeParse({
        cursor: url.searchParams.get("cursor") ?? undefined,
        limit: url.searchParams.get("limit") ?? undefined,
        since: url.searchParams.get("since") ?? undefined,
        status: url.searchParams.get("status") ?? undefined,
        type: url.searchParams.get("type") ?? undefined,
      });

      if (!query.success) {
        return apiError(400, "invalid_request", describeZodError(query.error));
      }

      const page = await listApiWebhookDeliveries(query.data);

      if (!page) {
        return apiError(
          400,
          "invalid_request",
          "cursor: not a cursor this API gave out.",
        );
      }

      return apiJson({
        data: page.data,
        nextCursor: page.nextCursor,
        object: "list",
      });
    },
  );
}
