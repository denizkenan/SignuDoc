import { apiJson } from "@/lib/api/http";
import { applyAccountLimit, handleApi } from "@/lib/api/route";
import { issueApiUpload } from "@/lib/api/uploads";

// A scoped upload URL: through the app for R2/local, directly to Blob on
// Vercel, where a request to the app is capped at 4.5 MB.
export async function POST(request: Request) {
  return handleApi(request, "write", "api_upload_failure", async (context) => {
    const limited = await applyAccountLimit(context, {
      key: "api-upload",
      limit: 60,
      windowMs: 10 * 60 * 1000,
    });

    if (limited) {
      return limited;
    }

    return apiJson(await issueApiUpload(context.actor.userId), { status: 201 });
  });
}
