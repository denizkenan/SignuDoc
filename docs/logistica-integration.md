# Integrating SignuDoc into Logistica

Production API: `https://sign.logistica-os.com/api/v1`

Machine-readable contract: <https://sign.logistica-os.com/api/v1/openapi.json>

This fork includes upstream PRs #44 (keys), #45 (API), #46 (webhooks), and #48 (embedded signing). The full request shapes, error codes, webhook verification and embedding details are in [api.md](api.md).

## Authentication and ownership

Under **Settings → Organization → API keys**, create a named write key for the backend. Keep the value in your backend's secret store. It is shown once and only its hash is stored by SignuDoc. Call `GET /api/v1/me` with `Authorization: Bearer <key>` to verify it.

Keys act as their administrator and access that account's envelopes. They are not tenant-specific credentials. Logistica must authorize tenant and entity access before calling SignuDoc. Use envelope `metadata` to associate the Logistica tenant, entity type and entity ID; metadata does not enforce access control. Do not put service keys into browser code.

## Create a signing request

Use a stable `Idempotency-Key` for each intended document version. Reusing it with the same request returns the original result; a changed request is refused. Keys are retained for 24 hours, so also persist the returned envelope ID in Logistica for longer-lived deduplication.

```sh
curl https://sign.logistica-os.com/api/v1/envelopes \
  -H "Authorization: Bearer $SIGNUDOC_API_KEY" \
  -H 'Idempotency-Key: agreement-1042-v1' \
  -F 'file=@agreement.pdf;type=application/pdf' \
  -F 'data={"title":"Agreement 1042","metadata":{"tenantId":"tenant-123","entityType":"agreement","entityId":"1042"},"signers":[{"ref":"customer","name":"Customer Name","email":"customer@example.com"}],"fields":[{"type":"signature","signer":"customer","page":1,"x":0.1,"y":0.75,"width":0.35,"height":0.06}],"send":{"permittedUseConfirmed":true,"expiresInDays":14}}'
```

The example sends a real invitation when run with a real key and recipient. To create only a draft, omit `send`. For repeated document layouts, use `GET /templates` and `POST /templates/{id}/envelopes`.

Cloudflare accepts PDFs up to 20 MiB through multipart. The optional `POST /uploads` → signed PUT → JSON create flow also works with R2; the URL expires in ten minutes. Pending files live under `uploads/` and expire after one day. Completed PDFs stay in the private bucket and are retrieved through authenticated API endpoints.

## Receive completion events

In **Settings → Organization → Webhooks**, add an HTTPS endpoint in Logistica and select events. Store the returned `whsec_...` secret in the receiving backend. The payload includes the envelope ID, metadata and signer state.

Verify the Standard Webhooks signature against the raw request body, enforce the timestamp tolerance, and deduplicate by `webhook-id`. Store the event durably before returning 2xx. Process the business update and file downloads in your own job queue. Delivery is at least once, so handle duplicates and reconcile current state with `GET /envelopes/{id}`.

After `envelope.completed`, download:

- `GET /envelopes/{id}/files/signed`
- `GET /envelopes/{id}/files/certificate`

Cloudflare delivers initial webhooks through Next.js `after()`. Pending retries schedule a Durable Object alarm for the next due attempt; no minute-by-minute polling keeps Xata awake. The daily retention cron also drains the outbox as a recovery backstop. Disabled endpoints are not scheduled.

## Show signing inside Logistica

Add the exact HTTPS origin of the frontend under **Settings → Organization → Embedded signing**. Embedded signing remains disabled until an administrator allows an origin.

Send an envelope with `send.delivery` set to `embedded`. From the backend, request:

`POST /envelopes/{id}/signers/{signerId}/embed-link`

with `{"origin":"https://your-logistica-frontend.example"}`. Give the returned URL to the intended user's browser and display it in an iframe. Check both the origin and source of any `postMessage`. Treat browser messages as UI signals; use signed webhooks or an authenticated API read to update business state.

Embedded signing currently supports simple signatures. It refuses Part 11 mode, access codes, emailed one-time codes, and advanced/qualified signature levels. Unopened links expire after 15 minutes; opened links last up to four hours, capped by the envelope deadline. The application embedding the page is responsible for identifying the signer. Completion copies are still emailed.

## Fork and deployment

Source: <https://github.com/denizkenan/SignuDoc>

Deployment and runtime decisions: [Cloudflare architecture](../cloudflare/architecture.md).

No API credential, webhook receiver, or allowed embedding origin is automatically granted to a Logistica application by this deployment. Those should be configured for the specific integrating backend and frontend.
