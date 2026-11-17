import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import {
  issueApiUpload,
  pendingUploadKeyFor,
  verifyApiUploadToken,
} from "./uploads.ts";

const USER = "4f7d0a9e-0d0b-4a43-9b8a-1f1d7e8f2a10";

test("an upload goes to the account's own pending folder, PDFs only", async () => {
  const issued: unknown[] = [];
  const presigned: unknown[] = [];
  const upload = await issueApiUpload(USER, {
    env: { STORAGE_DRIVER: "blob" },
    issueToken: async (options) => {
      issued.push(options);
      return { clientSigningToken: "c", delegationToken: "d" } as never;
    },
    now: Date.UTC(2026, 10, 17, 12),
    presign: (async (_token: unknown, options: unknown) => {
      presigned.push(options);
      return { presignedUrl: "https://blob.example/upload?sig=1" };
    }) as never,
  });

  assert.equal(upload.method, "PUT");
  assert.equal(upload.url, "https://blob.example/upload?sig=1");
  assert.equal(upload.expiresAt, "2026-11-17T12:10:00.000Z");
  assert.equal(
    pendingUploadKeyFor(USER, upload.uploadId),
    `uploads/${USER}/${upload.uploadId}.pdf`,
  );
  assert.deepEqual(
    (issued[0] as { allowedContentTypes: string[] }).allowedContentTypes,
    ["application/pdf"],
  );
  assert.equal((presigned[0] as { access: string }).access, "private");
  assert.equal(
    (presigned[0] as { allowOverwrite: boolean }).allowOverwrite,
    false,
  );
});

test("R2 uploads use a scoped, tamper-proof expiring URL without Blob credentials", async () => {
  const env = {
    STORAGE_DRIVER: "s3",
    APP_URL: "https://sign.example.com",
    BETTER_AUTH_SECRET: "test-upload-secret-0123456789abcdef0123456789",
  };
  const now = Date.UTC(2026, 10, 17, 12);
  const upload = await issueApiUpload(USER, { env, now });
  const url = new URL(upload.url);
  const token = url.searchParams.get("token");
  assert.equal(url.origin, env.APP_URL);
  assert.equal(url.pathname, `/api/v1/uploads/${upload.uploadId}`);
  assert.deepEqual(verifyApiUploadToken(upload.uploadId, token, { env, now }), {
    userId: USER,
    key: pendingUploadKeyFor(USER, upload.uploadId),
  });
  assert.equal(verifyApiUploadToken(randomUUID(), token, { env, now }), null);
  assert.equal(
    verifyApiUploadToken(upload.uploadId, `x${token}`, { env, now }),
    null,
  );
  assert.equal(
    verifyApiUploadToken(upload.uploadId, token, { env, now: now + 600_000 }),
    null,
  );
  assert.equal(
    verifyApiUploadToken(upload.uploadId, token, {
      env: {
        ...env,
        BETTER_AUTH_SECRET: "another-test-secret-0123456789abcdef",
      },
      now,
    }),
    null,
  );
});

test("an upload id that is not ours does not name a file", () => {
  assert.equal(pendingUploadKeyFor(USER, "../../etc/passwd"), null);
  assert.equal(pendingUploadKeyFor(USER, "not-a-uuid"), null);
});
