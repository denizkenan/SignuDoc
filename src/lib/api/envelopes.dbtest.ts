import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { PDFDocument } from "pdf-lib";
import type pg from "pg";

import { createApiKey } from "../api-keys.ts";
import { openTestDatabase } from "../db/test-database.ts";
import { EnvelopeMutationError } from "../envelopes.ts";
import { recordAuditEvent } from "../services/audit.ts";
import {
  apiCreateEnvelopeSchema,
  createEnvelopeForApi,
  getApiEnvelope,
  listApiEnvelopes,
  type ApiActor,
} from "./envelopes.ts";
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  deleteExpiredIdempotencyKeys,
  IDEMPOTENCY_WINDOW_SECONDS,
  rememberIdempotentResource,
} from "./idempotency.ts";

// The public API's envelopes against a real Postgres and real files. Run
// with `npm run test:db`.

const SETTINGS = [
  "APP_URL",
  "DATABASE_URL",
  "EMAIL_CAPTURE_DIR",
  "EMAIL_DRIVER",
  "STORAGE_DRIVER",
  "STORAGE_LOCAL_DIR",
] as const;

let database: pg.Pool;
let workDir: string;
let pdf: Uint8Array;
const createdUsers: string[] = [];
const settingsBefore = new Map<string, string | undefined>();

before(async () => {
  database = await openTestDatabase();
  workDir = await mkdtemp(path.join(tmpdir(), "signudoc-api-"));

  for (const name of SETTINGS) {
    settingsBefore.set(name, process.env[name]);
  }

  process.env.APP_URL = "http://localhost:3000";
  process.env.DATABASE_URL =
    process.env.E2E_DATABASE_URL ??
    "postgres://signudoc:signudoc@127.0.0.1:5432/signudoc_e2e";
  process.env.EMAIL_CAPTURE_DIR = path.join(workDir, "outbox");
  process.env.EMAIL_DRIVER = "capture";
  process.env.STORAGE_DRIVER = "local";
  process.env.STORAGE_LOCAL_DIR = path.join(workDir, "storage");

  const document = await PDFDocument.create();

  document.addPage([612, 792]);
  pdf = await document.save();
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();

  for (const [name, value] of settingsBefore) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  await rm(workDir, { force: true, recursive: true });
});

async function createActor(): Promise<ApiActor> {
  const userId = randomUUID();
  const email = `${userId}@example.test`;

  createdUsers.push(userId);
  await database.query(
    `
      insert into public."user" (id, name, email, role, "emailVerified")
      values ($1, 'Billing App', $2, 'admin', true)
    `,
    [userId, email],
  );

  const { summary } = await createApiKey(
    { email, userId },
    { expiresInDays: null, name: "Billing app", scope: "write" },
    database,
  );

  return {
    apiKeyId: summary.id,
    email,
    ipAddress: "203.0.113.7",
    name: "Billing App",
    userAgent: "billing-app/1.0",
    userId,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return apiCreateEnvelopeSchema.parse({
    fields: [
      {
        height: 0.05,
        page: 1,
        signer: "client",
        type: "signature",
        width: 0.3,
        x: 0.1,
        y: 0.8,
      },
      {
        height: 0.05,
        page: 1,
        signer: "witness",
        type: "signature",
        width: 0.3,
        x: 0.5,
        y: 0.8,
      },
      {
        height: 0.03,
        page: 1,
        signer: "client",
        type: "date",
        width: 0.2,
        x: 0.1,
        y: 0.9,
      },
    ],
    metadata: { invoice: "INV-1042" },
    signers: [
      { email: "client@example.test", name: "Casey Client", ref: "client" },
      { email: "witness@example.test", name: "Wes Witness", ref: "witness" },
    ],
    title: "Service agreement",
    ...overrides,
  });
}

const source = () => ({
  body: pdf,
  contentType: "application/pdf",
  filename: "agreement.pdf",
});

test("one call creates and sends an envelope, with refs, metadata and the key in the trail", async () => {
  const actor = await createActor();
  const envelope = await createEnvelopeForApi(
    actor,
    request({ send: { expiresInDays: 14, permittedUseConfirmed: true } }),
    source(),
    database,
  );

  assert.equal(envelope.status, "sent");
  assert.deepEqual(envelope.metadata, { invoice: "INV-1042" });
  assert.deepEqual(
    envelope.signers.map((signer) => [signer.ref, signer.order, signer.status]),
    [
      ["client", 1, "notified"],
      ["witness", 2, "pending"],
    ],
  );
  assert.ok(envelope.expiresAt);
  assert.equal(envelope.files.signed, null);

  const fields = await database.query<{ signerId: string }>(
    `select signer_id as "signerId" from fields where envelope_id = $1`,
    [envelope.id],
  );
  const clientId = envelope.signers[0]?.id;

  assert.equal(
    fields.rows.filter((row) => row.signerId === clientId).length,
    2,
  );

  const sent = await database.query<{ apiKeyId: string; ip: string }>(
    `
      select metadata->>'apiKeyId' as "apiKeyId", ip_address as ip
      from audit_events where envelope_id = $1 and event = 'sent'
    `,
    [envelope.id],
  );

  assert.deepEqual(sent.rows[0], {
    apiKeyId: actor.apiKeyId,
    ip: "203.0.113.7",
  });

  const stored = await database.query<{ apiKeyId: string }>(
    `select api_key_id as "apiKeyId" from envelopes where id = $1`,
    [envelope.id],
  );

  assert.equal(stored.rows[0]?.apiKeyId, actor.apiKeyId);
});

test("a create that cannot be finished leaves no draft behind", async () => {
  const actor = await createActor();
  const countDrafts = async () =>
    (
      await database.query(`select 1 from envelopes where user_id = $1`, [
        actor.userId,
      ])
    ).rowCount;

  await assert.rejects(
    createEnvelopeForApi(
      actor,
      request({
        fields: [
          {
            height: 0.05,
            page: 3,
            signer: "client",
            type: "signature",
            width: 0.3,
            x: 0.1,
            y: 0.8,
          },
          {
            height: 0.05,
            page: 1,
            signer: "witness",
            type: "signature",
            width: 0.3,
            x: 0.5,
            y: 0.8,
          },
        ],
      }),
      source(),
      database,
    ),
    (error: unknown) =>
      error instanceof EnvelopeMutationError && /1 page/.test(error.message),
  );

  // A witness with no signature field: the send is refused.
  await assert.rejects(
    createEnvelopeForApi(
      actor,
      request({
        fields: [
          {
            height: 0.05,
            page: 1,
            signer: "client",
            type: "signature",
            width: 0.3,
            x: 0.1,
            y: 0.8,
          },
        ],
        send: { permittedUseConfirmed: true },
      }),
      source(),
      database,
    ),
    (error: unknown) =>
      error instanceof EnvelopeMutationError &&
      /Signature field/.test(error.message),
  );

  assert.equal(await countDrafts(), 0);
});

test("the request is checked before anything is written", () => {
  assert.throws(() =>
    request({
      fields: [
        {
          height: 0.05,
          page: 1,
          signer: "nobody",
          type: "signature",
          width: 0.3,
          x: 0.1,
          y: 0.8,
        },
      ],
    }),
  );
  assert.throws(() =>
    request({
      signers: [
        { email: "a@example.test", name: "A", ref: "same" },
        { email: "b@example.test", name: "B", ref: "same" },
      ],
    }),
  );
  assert.throws(() => request({ metadata: { blob: "x".repeat(3000) } }));
  assert.throws(() => request({ send: { permittedUseConfirmed: false } }));
});

test("an envelope is visible only to the key's own account", async () => {
  const owner = await createActor();
  const stranger = await createActor();
  const envelope = await createEnvelopeForApi(
    owner,
    request(),
    source(),
    database,
  );

  assert.equal(envelope.status, "draft");
  assert.ok(await getApiEnvelope(owner.userId, envelope.id, database));
  assert.equal(
    await getApiEnvelope(stranger.userId, envelope.id, database),
    null,
  );
});

test("the list pages with a cursor, newest first, and filters by status", async () => {
  const actor = await createActor();
  const ids: string[] = [];

  for (let index = 0; index < 3; index += 1) {
    ids.push(
      (await createEnvelopeForApi(actor, request(), source(), database)).id,
    );
  }

  // Same-second creations still come back in a stable order.
  const first = await listApiEnvelopes(actor.userId, { limit: 2 }, database);

  assert.equal(first.data.length, 2);
  assert.ok(first.nextCursor);

  const second = await listApiEnvelopes(
    actor.userId,
    { cursor: first.nextCursor ?? undefined, limit: 2 },
    database,
  );

  assert.equal(second.data.length, 1);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(
    new Set([...first.data, ...second.data].map((envelope) => envelope.id)),
    new Set(ids),
  );
  assert.equal(
    (
      await listApiEnvelopes(
        actor.userId,
        { limit: 25, status: "sent" },
        database,
      )
    ).data.length,
    0,
  );
});

test("an idempotency key replays the first response and refuses a different request", async () => {
  const actor = await createActor();
  const claim = {
    apiKeyId: actor.apiKeyId,
    key: "order-1042",
    requestHash: "a".repeat(64),
  };

  assert.deepEqual(await claimIdempotencyKey(claim, database), { kind: "new" });
  assert.deepEqual(await claimIdempotencyKey(claim, database), {
    kind: "in_progress",
  });

  await completeIdempotencyKey(
    {
      apiKeyId: actor.apiKeyId,
      key: "order-1042",
      response: { id: "env_1" },
      statusCode: 201,
    },
    database,
  );

  assert.deepEqual(await claimIdempotencyKey(claim, database), {
    kind: "replay",
    response: { id: "env_1" },
    statusCode: 201,
  });
  assert.deepEqual(
    await claimIdempotencyKey(
      { ...claim, requestHash: "b".repeat(64) },
      database,
    ),
    { kind: "mismatch" },
  );

  // Another key may use the same value for its own request.
  const other = await createActor();

  assert.deepEqual(
    await claimIdempotencyKey({ ...claim, apiKeyId: other.apiKeyId }, database),
    { kind: "new" },
  );

  // After the window the value is free again.
  const later = Math.floor(Date.now() / 1000) + IDEMPOTENCY_WINDOW_SECONDS + 1;

  assert.deepEqual(
    await claimIdempotencyKey(
      { ...claim, requestHash: "c".repeat(64) },
      database,
      later,
    ),
    { kind: "new" },
  );
  assert.ok(
    (await deleteExpiredIdempotencyKeys(
      database,
      later + IDEMPOTENCY_WINDOW_SECONDS,
    )) >= 1,
  );
});

test("once the envelope is made and sent, a retry is told about it instead of making another", async () => {
  const actor = await createActor();
  const claim = {
    apiKeyId: actor.apiKeyId,
    key: `order-${randomUUID()}`,
    requestHash: "d".repeat(64),
  };
  const remembered: string[] = [];

  assert.deepEqual(await claimIdempotencyKey(claim, database), { kind: "new" });

  const envelope = await createEnvelopeForApi(
    actor,
    request({ send: { permittedUseConfirmed: true } }),
    source(),
    database,
    {
      onCreated: async (envelopeId) => {
        // Only once the send has happened.
        const row = await database.query<{ status: string }>(
          `select status from envelopes where id = $1`,
          [envelopeId],
        );

        assert.equal(row.rows[0]?.status, "sent");
        remembered.push(envelopeId);
        await rememberIdempotentResource(
          { apiKeyId: claim.apiKeyId, key: claim.key, resourceId: envelopeId },
          database,
        );
      },
    },
  );

  assert.deepEqual(remembered, [envelope.id]);
  // Say the answer could not be read back and the request failed here: the
  // key is kept, and the retry is pointed at the envelope.
  assert.deepEqual(await claimIdempotencyKey(claim, database), {
    kind: "recover",
    resourceId: envelope.id,
  });
});

test("a create that fails is not remembered, so its retry runs for real", async () => {
  const actor = await createActor();
  let called = false;

  await assert.rejects(
    createEnvelopeForApi(
      actor,
      request({
        fields: [
          {
            height: 0.05,
            page: 9,
            signer: "client",
            type: "signature",
            width: 0.3,
            x: 0.1,
            y: 0.7,
          },
        ],
      }),
      source(),
      database,
      {
        onCreated: async () => {
          called = true;
        },
      },
    ),
    EnvelopeMutationError,
  );
  assert.equal(called, false);
});

test("a corrected signer does not inherit the first view of the person before", async () => {
  const actor = await createActor();
  const envelope = await createEnvelopeForApi(
    actor,
    request({ send: { permittedUseConfirmed: true } }),
    source(),
    database,
  );
  const client = envelope.signers[0]!;

  await recordAuditEvent(
    {
      actorEmail: client.email,
      actorType: "signer",
      envelopeId: envelope.id,
      event: "viewed",
      metadata: { signerEmail: client.email, signerId: client.id },
    },
    database,
  );

  const viewed = await getApiEnvelope(actor.userId, envelope.id, database);

  assert.ok(viewed?.signers[0]?.viewedAt);

  // A correction keeps the signer id and changes the address.
  await database.query(`update signers set email = $2 where id = $1`, [
    client.id,
    "corrected@example.test",
  ]);

  const corrected = await getApiEnvelope(actor.userId, envelope.id, database);

  assert.equal(corrected?.signers[0]?.viewedAt, null);
});
