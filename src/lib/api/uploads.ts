import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import {
  issueSignedToken,
  presignUrl,
  type IssuedSignedToken,
} from "@vercel/blob";

import {
  buildPendingUploadPrefix,
  isPendingUploadKey,
} from "../services/storage-keys.ts";
import { MAX_UPLOAD_SIZE_BYTES } from "../types/domain.ts";
import { resolveStorageDriver } from "../services/storage/driver.ts";
import { getEnv, resolveAppUrl, type EnvSource } from "../utils/env.ts";

// Large PDFs for the API. A request to a Vercel Function is capped at
// 4.5 MB, so a bigger file goes straight to Vercel Blob: the API hands out a
// signed URL good for one PUT of one PDF, the caller uploads to it, and then
// names the upload when it creates the envelope. The file is read back and
// checked like any other upload. One that is never used is deleted by Blob
// after a day. This is the same signed-URL mechanism the web app's upload
// page uses.

const UPLOAD_URL_LIFETIME_MS = 10 * 60 * 1000;
const PENDING_UPLOAD_TTL_DAYS = 1;

type IssueToken = (options: {
  allowedContentTypes: string[];
  maximumSizeInBytes: number;
  operations: ["put"];
  pathname: string;
  validUntil: number;
}) => Promise<IssuedSignedToken>;

type Presign = typeof presignUrl;

export type ApiUpload = {
  expiresAt: string;
  headers: Record<string, string>;
  maxBytes: number;
  method: "PUT";
  uploadId: string;
  url: string;
};

export function pendingUploadKeyFor(
  userId: string,
  uploadId: string,
): string | null {
  const key = `${buildPendingUploadPrefix(userId)}${uploadId}.pdf`;

  return isPendingUploadKey(key, userId) ? key : null;
}

export async function issueApiUpload(
  userId: string,
  {
    issueToken = issueSignedToken,
    now = Date.now(),
    presign = presignUrl,
    env = process.env,
  }: {
    issueToken?: IssueToken;
    now?: number;
    presign?: Presign;
    env?: EnvSource;
  } = {},
): Promise<ApiUpload> {
  const uploadId = randomUUID();
  const pathname = pendingUploadKeyFor(userId, uploadId);

  if (!pathname) {
    throw new Error("Could not build an upload path for this account.");
  }

  const validUntil = now + UPLOAD_URL_LIFETIME_MS;
  if (resolveStorageDriver(env) !== "blob") {
    const payload = Buffer.from(
      JSON.stringify({ userId, uploadId, validUntil }),
    ).toString("base64url");
    const signature = uploadSignature(payload, env).toString("base64url");
    const origin = resolveAppUrl(env);
    if (!origin) throw new Error("APP_URL is required to issue an upload URL.");
    const url = new URL(`/api/v1/uploads/${uploadId}`, origin);
    url.searchParams.set("token", `${payload}.${signature}`);
    return {
      expiresAt: new Date(validUntil).toISOString(),
      headers: { "content-type": "application/pdf" },
      maxBytes: MAX_UPLOAD_SIZE_BYTES,
      method: "PUT",
      uploadId,
      url: url.href,
    };
  }
  const token = await issueToken({
    allowedContentTypes: ["application/pdf"],
    maximumSizeInBytes: MAX_UPLOAD_SIZE_BYTES,
    operations: ["put"],
    pathname,
    validUntil,
  });
  const { presignedUrl } = await presign(token, {
    access: "private",
    addRandomSuffix: false,
    allowedContentTypes: ["application/pdf"],
    allowOverwrite: false,
    maximumSizeInBytes: MAX_UPLOAD_SIZE_BYTES,
    operation: "put",
    pathname,
    ttlDays: PENDING_UPLOAD_TTL_DAYS,
    validUntil,
  });

  return {
    expiresAt: new Date(validUntil).toISOString(),
    headers: { "content-type": "application/pdf" },
    maxBytes: MAX_UPLOAD_SIZE_BYTES,
    method: "PUT",
    uploadId,
    url: presignedUrl,
  };
}

function uploadSignature(payload: string, env: EnvSource): Buffer {
  const secret = getEnv(env).auth.betterAuthSecret;
  if (!secret)
    throw new Error("BETTER_AUTH_SECRET is required to issue an upload URL.");
  return createHmac("sha256", secret).update(`api-upload:${payload}`).digest();
}

/** A capability for one account, upload, method and expiry; never an API key. */
export function verifyApiUploadToken(
  uploadId: string,
  token: string | null,
  {
    env = process.env,
    now = Date.now(),
  }: { env?: EnvSource; now?: number } = {},
): { key: string; userId: string } | null {
  if (!token || token.length > 2048 || !/^[\w-]+\.[\w-]+$/.test(token))
    return null;
  const [payload, signature] = token.split(".");
  const supplied = Buffer.from(signature, "base64url");
  const expected = uploadSignature(payload, env);
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (
      data.uploadId !== uploadId ||
      typeof data.userId !== "string" ||
      !Number.isSafeInteger(data.validUntil) ||
      data.validUntil <= now
    )
      return null;
    const key = pendingUploadKeyFor(data.userId, uploadId);
    return key ? { key, userId: data.userId } : null;
  } catch {
    return null;
  }
}
