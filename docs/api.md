# The SignuDoc API

Another app can use SignuDoc through its API: check a key works now, and
create, send and track envelopes as the next releases add those endpoints.
Everything here runs inside your own install; nothing goes through a
service of ours.

The API is version 1 and lives under `/api/v1` on your install, for example
`https://sign.example.com/api/v1`. Within version 1, endpoints, fields and
error codes are only ever added, never changed or removed.

## Keys

An administrator makes a key under **Settings, Organization, API keys**:

1. Give it a name that says which app uses it, such as "Billing app".
2. Choose **Read and write** (create, send and void envelopes, and read
   them) or **Read only**.
3. Choose when it expires: in 30 days, 90 days, a year, or never.
4. Copy the key. It starts with `sdk_` and is shown only this once; SignuDoc
   keeps only a hash of it.

Send the key in the `Authorization` header of every request:

```sh
curl https://sign.example.com/api/v1/me \
  -H "Authorization: Bearer sdk_…"
```

```json
{
  "key": { "id": "…", "name": "Billing app", "scope": "write" },
  "user": { "email": "ops@example.com", "id": "…", "name": "Ops" }
}
```

What to know about keys:

- **A key acts as the administrator who made it.** Envelopes it creates are
  theirs and show in their documents, sent in their name. An app that should
  send in its own name gets its own administrator account (for example
  "Billing app", with a shared mailbox) and its key from there.
- **A key stops working** the moment it is revoked, when it expires, when
  its administrator stops being an administrator, or when their account is
  being closed. A key that stopped because its administrator lost the role
  stays revoked if they get it back; make a new one.
- **Keys skip two-step sign-in.** They are for servers, so keep them in your
  app's secret settings (for example a Vercel environment variable), never
  in a browser or a mobile app, and revoke a key as soon as it may have
  leaked. The `sdk_` prefix lets secret scanners such as GitHub's spot one.
- Each administrator can have up to 25 keys that have not been revoked or
  expired.
- Making and revoking keys is recorded in the site audit trail (Settings,
  Organization, Sign-in security), and each key shows when it was last used.

## Errors

Every error has the same shape, and the code is meant for your program:

```json
{
  "error": {
    "code": "unauthorized",
    "message": "Send a valid API key as \"Authorization: Bearer sdk_…\"."
  }
}
```

| Status | Code                     | Meaning                                                                                  |
| ------ | ------------------------ | ---------------------------------------------------------------------------------------- |
| 400    | `invalid_request`        | The request is missing something or has a value that is not allowed.                     |
| 401    | `unauthorized`           | No key, or one that is unknown, revoked or expired. All of these look the same.          |
| 403    | `forbidden`              | The key may not do this, such as a read-only key asked to send.                          |
| 404    | `not_found`              | There is no such thing, or the key's administrator cannot see it.                        |
| 409    | `wrong_state`            | Not possible in the envelope's current state, such as sending one that was sent already. |
| 413    | `payload_too_large`      | The file is too big.                                                                     |
| 422    | `idempotency_key_reused` | An `Idempotency-Key` was used before with a different request.                           |
| 429    | `rate_limited`           | Too many requests. Wait the number of seconds in `Retry-After`.                          |
| 500    | `internal_error`         | Something went wrong on the install. Try again later.                                    |

## Rate limits

Each key may make 600 requests in 10 minutes. Every response says where it
stands:

- `RateLimit-Limit`: requests allowed in the window.
- `RateLimit-Remaining`: requests left in it.
- `RateLimit-Reset`: seconds until the window starts again.

The limits the web app has on creating and sending envelopes apply to keys
too. An address that sends 30 bad keys in 10 minutes is turned away until
the 10 minutes are up.

## Endpoints

| Method and path  | Access | What it does                           |
| ---------------- | ------ | -------------------------------------- |
| `GET /api/v1/me` | read   | Which key this is and whom it acts as. |
