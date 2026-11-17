import { NextResponse } from "next/server";

import { requireAdminSession } from "../auth/admin.ts";
import { logRouteError } from "../security/logging.ts";
import {
  getClientIpAddress,
  getRequestPathname,
  getRequestUserAgent,
} from "../security/request.ts";
import { getSettings } from "../settings.ts";
import { WebhookEndpointError, type WebhookActor } from "./endpoints.ts";

// What every /api/admin/webhooks route shares: administrators only, not on
// a hosted install, never cached, and known errors become plain messages.

export const noStore = { "cache-control": "private, no-store" };

export async function handleWebhookAdmin(
  request: Request,
  category: string,
  run: (actor: WebhookActor) => Promise<Response>,
): Promise<Response> {
  const sessionResult = await requireAdminSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  if ((await getSettings()).hosted) {
    return NextResponse.json(
      { error: "Webhooks are for self-hosted installs." },
      { headers: noStore, status: 400 },
    );
  }

  const actor: WebhookActor = {
    email: sessionResult.user.email,
    ipAddress: getClientIpAddress(request.headers),
    userAgent: getRequestUserAgent(request.headers),
    userId: sessionResult.user.id,
  };

  try {
    return await run(actor);
  } catch (error) {
    if (error instanceof WebhookEndpointError) {
      return NextResponse.json(
        { error: error.message },
        { headers: noStore, status: error.statusCode },
      );
    }

    logRouteError(error, {
      category,
      ipAddress: actor.ipAddress ?? null,
      message: "Unexpected failure in a webhook settings request.",
      path: getRequestPathname(request),
      userId: actor.userId,
    });

    return NextResponse.json(
      { error: "Something went wrong. Try again." },
      { headers: noStore, status: 500 },
    );
  }
}

/** The JSON object in a request body, or an empty one. */
export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const parsed: unknown = await request.json().catch(() => null);

  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}
