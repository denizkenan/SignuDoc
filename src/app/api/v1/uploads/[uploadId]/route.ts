import { apiError, apiJson } from "@/lib/api/http";
import { verifyApiUploadToken } from "@/lib/api/uploads";
import { DocumentImportError } from "@/lib/services/document-import";
import { readStreamWithLimit } from "@/lib/services/pending-uploads";
import { createStorageService } from "@/lib/services/storage";
import { MAX_UPLOAD_SIZE_BYTES } from "@/lib/types/domain";

/** Signed PUT capability issued by POST /uploads. The bucket stays private. */
export async function PUT(
  request: Request,
  context: { params: Promise<{ uploadId: string }> },
) {
  const { uploadId } = await context.params;
  const authorized = verifyApiUploadToken(
    uploadId,
    new URL(request.url).searchParams.get("token"),
  );
  if (!authorized)
    return apiError(401, "unauthorized", "Invalid or expired upload URL.");
  if (
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
    "application/pdf"
  ) {
    return apiError(400, "invalid_request", "Upload an application/pdf body.");
  }
  if (!request.body)
    return apiError(400, "invalid_request", "A PDF body is required.");
  if (Number(request.headers.get("content-length")) > MAX_UPLOAD_SIZE_BYTES) {
    return apiError(413, "payload_too_large", "The PDF is too large.");
  }
  try {
    const body = await readStreamWithLimit(request.body, MAX_UPLOAD_SIZE_BYTES);
    await createStorageService().putObject({
      key: authorized.key,
      body,
      contentType: "application/pdf",
      keepExisting: true,
    });
    return apiJson({ object: "upload", uploadId }, { status: 201 });
  } catch (error) {
    if (error instanceof DocumentImportError)
      return apiError(413, "payload_too_large", error.message);
    console.error("[api-upload] Storing a pending PDF failed.", error);
    return apiError(
      500,
      "internal_error",
      "The PDF could not be stored. Try again.",
    );
  }
}
