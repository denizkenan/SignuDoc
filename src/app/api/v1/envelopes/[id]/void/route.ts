import { apiError, apiJson } from "@/lib/api/http";
import { getApiEnvelope } from "@/lib/api/envelopes";
import { handleApi } from "@/lib/api/route";
import { voidSentEnvelope } from "@/lib/envelopes";

type Context = { params: Promise<{ id: string }> };

// Voids an envelope that is out for signature. The signers are told, and
// nobody can sign it any more.
export async function POST(request: Request, context: Context) {
  const { id } = await context.params;

  return handleApi(
    request,
    "write",
    "api_envelope_void_failure",
    async ({ actor }) => {
      // No body is fine; a body that is not a JSON object is refused, so a
      // cut-off request never voids without the reason it meant to give.
      const text = await request.text();
      let body: unknown = {};

      if (text.trim()) {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          return apiError(
            400,
            "invalid_request",
            "The body is not valid JSON.",
          );
        }
      }

      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return apiError(
          400,
          "invalid_request",
          'The body must be a JSON object, such as {"reason": "..."}.',
        );
      }

      const reason = (body as { reason?: unknown }).reason;

      if (
        reason !== undefined &&
        reason !== null &&
        typeof reason !== "string"
      ) {
        return apiError(400, "invalid_request", "reason must be a string.");
      }

      await voidSentEnvelope(actor.userId, id, {
        ipAddress: actor.ipAddress,
        reason: reason ?? null,
        senderEmail: actor.email,
        senderName: actor.name.trim() ? actor.name : actor.email,
        userAgent: actor.userAgent,
      });

      const envelope = await getApiEnvelope(actor.userId, id);

      return envelope
        ? apiJson(envelope)
        : apiError(404, "not_found", "Envelope not found.");
    },
  );
}
