# Deployment choice: Workers with Containers

This checkout follows [upstream PR #51](https://github.com/NYLLON-SOFTWARE/SignuDoc/pull/51), with a Worker routing requests to one Cloudflare Container. R2 holds private documents; Xata provides PostgreSQL; Cloudflare Email Sending uses `sign@logistica-os.com`.

## Why Containers fit this app

| Concern        | App directly in Workers                                                                                                           | Worker with a Container                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Next.js 16     | Requires a deployment adapter and compatibility testing. Cloudflare currently recommends vinext, in beta.                         | Runs the app's existing Node.js 24 server.                                                                                         |
| PDF processing | Must adapt font paths and import precompiled WebAssembly. Memory is limited to 128 MB per isolate, including concurrent requests. | Keeps the existing font files, runtime HarfBuzz compilation, RSA sealing, and PDF processing in a 1 GiB instance.                  |
| PostgreSQL     | Supported, but does not make the app compatible with D1.                                                                          | Preserves transactions, advisory locks, schema, and Better Auth's PostgreSQL integration.                                          |
| Idle operation | No process needs to stay warm; better startup latency and idle cost.                                                              | This PR sleeps after 15 minutes. A cold request must wait for the container, database connection, migrations, and Next.js startup. |
| Scaling        | Automatic request scaling.                                                                                                        | This PR routes to one instance; concurrency and capacity are bounded by that instance.                                             |

**Recommendation:** use the container approach for this existing application. A direct Workers port is worth considering if lower cold-start latency or broad request scaling becomes more important, after validating PDF signing and memory use in the actual Workers runtime. A hybrid could eventually move PDF processing into a container while serving the UI and APIs in Workers, but adds another service boundary.

The image now uses a separate runtime stage and Next.js standalone output, runs as the unprivileged `node` user, and explicitly includes the migrations, fonts, and HarfBuzz module. The measured local image shrank from approximately 757 MB to 471 MB (Docker's decimal size reporting). The first live setup request took 24.86 seconds including startup; a subsequent warm request took 0.44 seconds. These are single measurements, not latency guarantees.

## Cost implications

Workers Paid has a $5 monthly minimum. Containers add provisioned memory and disk charges while running, plus active CPU usage. At current rates, keeping the PR's `basic` instance (1 GiB memory, 4 GB disk) awake for 730 hours would add roughly $7.03 for memory and disk after the included allowances, before CPU, network, database, email, R2, and other account usage. Sleeping between visits reduces this. Direct Workers avoids the idle container allocation.

Prices and limits checked on 2026-11-17:

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Container pricing](https://developers.cloudflare.com/containers/platform/pricing/)
- [Container startup and scaling](https://developers.cloudflare.com/containers/faq/)
- [Next.js on Workers](https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/)
- [WebAssembly in Workers](https://developers.cloudflare.com/workers/runtime-apis/webassembly/)

## Xata and sleep settings

The Xata project is `signudoc`, branch `main`, in Xata organization `s29thi`, project `prj_iogau73hkt5trfbc69cr5i9g50`, Frankfurt (`eu-central-1`). It uses PostgreSQL 17.12, `xata.micro`, 5 GB storage, and no read replicas.

Automatic scale-to-zero is enabled with a **one-minute** inactivity period. Xata's CLI accepts whole minutes from 1 to 1440; five-second database sleep is unavailable. The Cloudflare app pool releases idle connections after **five seconds** so it does not keep the database awake for the container's full warm period. Hibernation can occur after the connection has closed and the provider's inactivity window has elapsed. A new direct PostgreSQL connection wakes the database.

Do not replace automatic scale-to-zero with manual hibernation: manually hibernated branches require an explicit wake-up operation.

- [Xata scale-to-zero](https://xata.io/docs/core-concepts/scale-to-zero)
- [Xata CLI](https://xata.io/docs/cli/branch)

## Deploy and operate

- Site: <https://sign.logistica-os.com>
- Original Worker address: <https://signudoc.kenan-4a4.workers.dev>
- Worker: `signudoc`
- Container class: `SignuDocApp`, instance name `app`
- Private R2 bucket: `signudoc-documents`, Western Europe location hint
- Retention schedule: daily at 09:00 UTC
- Sender: `sign@logistica-os.com`

```sh
npm ci
npm run check:cloudflare
npm run deploy:cloudflare
```

Wrangler is pinned in `package-lock.json`. The GitHub deployment workflow installs from that lockfile too. It requires the repository's `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` secrets; the fork is published at `denizkenan/SignuDoc` on `main`. GitHub CI validates pushes; production deployment requires the Cloudflare repository secrets or the authenticated local CLI.

Runtime secrets are stored on the Worker. The ignored local `.data/cloudflare/` directory contains recovery copies, including `setup-token` for the first-run setup form and `secrets.json`. Keep them private. The first administrator still needs to complete `/setup` and choose their own password and organization details.

Tests use disposable local PostgreSQL and captured email, so the live Xata database remains ready for the owner's first-run setup. No real invitation or test email is sent by validation.

## Validation

- Production Next.js build and AMD64 container build passed.
- Typecheck and lint passed; lint retains seven upstream warnings.
- All 350 unit tests passed on Node.js 24 in GitHub CI, including the shell-workflow cases that need modern Git, Bash and `jq`.
- All 233 database tests and eight Playwright browser tests passed against disposable PostgreSQL, including API sending, signed webhooks, key revocation and cross-site embedded signing.
- The production runtime image served the setup form with a 1 GiB memory limit locally.
- Live setup returned HTTP 200, rendered in Chromium with no page errors, and required a setup token. Unauthenticated envelope creation and retention requests returned HTTP 401.
- A temporary object was written to R2, downloaded and compared byte-for-byte, then deleted.
- Cloudflare Email Sending is enabled; its DKIM and return-path MX records resolve publicly. The administrator subsequently sent a successful test email; the current sender is `sign@logistica-os.com`.

## Public API, webhooks and embedding

This fork includes PR #44 (`bae672e`), #45 (`1e041f3`), #46 (`2f645b7`) and #48 (`5c50981`). The integration contract is served at `/api/v1/openapi.json`; [Logistica integration](../docs/logistica-integration.md) explains authentication, ownership, idempotency, signed webhooks and embedding.

The API upload flow works with private R2. It issues a ten-minute signed capability for one upload path and bounds the streamed body at 20 MiB. A repeated PUT preserves the first file. A bucket lifecycle rule expires unused `uploads/` objects after one day. Envelope files under `users/` are unaffected.

Initial webhook delivery runs through Next.js `after()`. Each drain reports the next pending attempt or lease expiry to a token-protected internal Worker gateway. The Durable Object persists an alarm, starts the container only when needed, and calls `/api/internal/webhooks` with the job secret. The daily cron also drains the outbox as a recovery path. This preserves Xata scale-to-zero between actual work. Query strings are redacted from Worker logs to protect signed upload and signing links.

The Cloudflare runtime test also verifies image-change restarts, authenticated retry scheduling, persistence across Durable Object eviction and one-shot alarm delivery. Live API verification exercised a 5.25 MB R2 upload, read-only scope enforcement, idempotent draft creation, retrieval, deletion and key revocation. Existing application records were preserved; the temporary test credentials were revoked.
