import { apiJson } from "@/lib/api/http";
import { applyAccountLimit, handleApi } from "@/lib/api/route";
import { issueEmbedLink } from "@/lib/embedding";

type RouteContext = { params: Promise<{ id: string; signerId: string }> };

// A signing link for an embedded envelope, for the signer whose turn it
// is, to show in a frame on an allowed site. Each call replaces the
// signer's last link. See docs/api.md, "Embedded signing".

export async function POST(request: Request, context: RouteContext) {
  return handleApi(request, "write", "api_embed_link_failure", async (api) => {
    const limited = await applyAccountLimit(api, {
      key: "api-embed-link",
      limit: 300,
      windowMs: 10 * 60 * 1000,
    });

    if (limited) {
      return limited;
    }

    const { id, signerId } = await context.params;
    const body = (await request.json().catch(() => null)) as {
      origin?: unknown;
    } | null;

    const link = await issueEmbedLink({
      apiKeyId: api.actor.apiKeyId,
      envelopeId: id,
      origin: body?.origin,
      signerId,
      userId: api.actor.userId,
    });

    return apiJson({ ...link, object: "embed_link" }, { status: 201 });
  });
}
