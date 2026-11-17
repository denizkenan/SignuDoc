import { NextResponse } from "next/server";

import {
  addEmbedOrigin,
  EmbeddingError,
  listEmbedOrigins,
  removeEmbedOrigin,
} from "@/lib/embedding";
import {
  handleWebhookAdmin,
  noStore,
  readJsonObject,
} from "@/lib/webhooks/admin-route";

// The sites allowed to show signing pages in a frame (embedded signing).
// Administrators only, not on hosted installs.

function embeddingErrorResponse(error: unknown): Response {
  if (error instanceof EmbeddingError) {
    return NextResponse.json(
      { error: error.message },
      { headers: noStore, status: error.statusCode },
    );
  }

  throw error;
}

export function GET(request: Request) {
  return handleWebhookAdmin(request, "embed_origin_list_failure", async () =>
    NextResponse.json(
      { origins: await listEmbedOrigins() },
      { headers: noStore },
    ),
  );
}

export function POST(request: Request) {
  return handleWebhookAdmin(
    request,
    "embed_origin_add_failure",
    async (actor) => {
      const body = await readJsonObject(request);

      try {
        const origin = await addEmbedOrigin(actor, body.origin);

        return NextResponse.json({ origin }, { headers: noStore, status: 201 });
      } catch (error) {
        return embeddingErrorResponse(error);
      }
    },
  );
}

export function DELETE(request: Request) {
  return handleWebhookAdmin(
    request,
    "embed_origin_remove_failure",
    async (actor) => {
      const origin = new URL(request.url).searchParams.get("origin") ?? "";

      try {
        await removeEmbedOrigin(actor, origin);

        return NextResponse.json({ removed: true }, { headers: noStore });
      } catch (error) {
        return embeddingErrorResponse(error);
      }
    },
  );
}
