import { apiError } from "@/lib/api/http";
import { handleApi } from "@/lib/api/route";
import { createDownloadResponse } from "@/lib/download-response";
import { getSenderEnvelopeDownload } from "@/lib/downloads";

type Context = { params: Promise<{ file: string; id: string }> };

const FILE_TYPES = { certificate: "evidence", signed: "signed" } as const;

// The signed PDF (once completed) or the certificate of completion (once
// completed, declined or voided).
export async function GET(request: Request, context: Context) {
  const { file, id } = await context.params;

  return handleApi(
    request,
    "read",
    "api_envelope_file_failure",
    async ({ actor }) => {
      const type = FILE_TYPES[file as keyof typeof FILE_TYPES];

      if (!type) {
        return apiError(
          404,
          "not_found",
          "Ask for files/signed or files/certificate.",
        );
      }

      return createDownloadResponse(
        await getSenderEnvelopeDownload(actor.userId, id, type),
      );
    },
  );
}
