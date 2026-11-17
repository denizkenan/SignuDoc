import { z } from "zod";

import {
  getDb,
  queryMany,
  queryOne,
  type DbExecutor,
  type DbPool,
} from "../db/connection.ts";
import {
  createDraftEnvelope,
  deleteDraftEnvelope,
  EnvelopeMutationError,
  replaceDraftEnvelopeFields,
  replaceDraftEnvelopeSigners,
  sendDraftEnvelope,
} from "../envelopes.ts";
import {
  emailSchema,
  envelopeTitleSchema,
  nameSchema,
} from "../schemas/common.ts";
import {
  deadlineDaysSchema,
  reminderIntervalDaysSchema,
} from "../schemas/envelope.ts";
import { fieldTypeSchema } from "../schemas/field.ts";
import {
  MAX_COPY_RECIPIENTS_PER_ENVELOPE,
  MAX_SIGNERS_PER_ENVELOPE,
  signatureMeanings,
  type EnvelopeStatus,
  type SignerStatus,
} from "../types/domain.ts";

// Envelopes as the public API sees them: one shape, ApiEnvelope, returned by
// every endpoint (and, later, carried by webhooks), and the one-call create.
// Everything that changes an envelope goes through the same functions the
// web app uses, so the same rules apply.

export const MAX_API_METADATA_BYTES = 2048;
export const MAX_API_FIELDS = 500;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

export type ApiSigner = {
  declinedAt: string | null;
  declineReason: string | null;
  email: string;
  id: string;
  name: string;
  order: number;
  ref: string | null;
  signedAt: string | null;
  status: SignerStatus;
  viewedAt: string | null;
};

export type ApiEnvelope = {
  completedAt: string | null;
  copyRecipients: Array<{ email: string; id: string; name: string }>;
  createdAt: string;
  declinedAt: string | null;
  expired: boolean;
  expiresAt: string | null;
  files: { certificate: string | null; signed: string | null };
  id: string;
  metadata: Record<string, unknown> | null;
  object: "envelope";
  pageCount: number;
  sentAt: string | null;
  signatureLevel: string;
  signers: ApiSigner[];
  status: EnvelopeStatus;
  title: string;
  voidedAt: string | null;
};

function isoTime(seconds: number | null | undefined): string | null {
  return typeof seconds === "number"
    ? new Date(seconds * 1000).toISOString()
    : null;
}

const refSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9._:-]+$/,
    "Use letters, digits, '.', '_', ':' or '-' in a ref.",
  );

const metadataSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (value) =>
      Buffer.byteLength(JSON.stringify(value), "utf8") <=
      MAX_API_METADATA_BYTES,
    {
      message: `Metadata must be at most ${String(MAX_API_METADATA_BYTES)} bytes of JSON.`,
    },
  );

export const apiSendOptionsSchema = z.object({
  expiresInDays: deadlineDaysSchema.optional(),
  permittedUseConfirmed: z.literal(true, {
    message:
      "Set permittedUseConfirmed to true to confirm the envelope is an ordinary business agreement (see /electronic-signatures on your install).",
  }),
  reminderIntervalDays: reminderIntervalDaysSchema.optional(),
  signatureLevel: z.enum(["simple", "advanced", "qualified"]).optional(),
});

const apiSignerSchema = z.object({
  accessCode: z.string().trim().min(4).max(64).optional(),
  email: emailSchema,
  name: nameSchema,
  ref: refSchema,
  requireEmailCode: z.boolean().optional(),
  signatureMeaning: z.enum(signatureMeanings).optional(),
});

const apiFieldSchema = z.object({
  groupId: z.string().trim().min(1).max(64).optional(),
  height: z.number().finite().gt(0).max(1),
  label: z.string().trim().max(120).optional(),
  options: z.array(z.string()).optional(),
  page: z.number().int().positive(),
  required: z.boolean().optional(),
  signer: refSchema,
  type: fieldTypeSchema,
  width: z.number().finite().gt(0).max(1),
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
});

export const apiCreateEnvelopeSchema = z
  .object({
    copyRecipients: z
      .array(z.object({ email: emailSchema, name: nameSchema }))
      .max(MAX_COPY_RECIPIENTS_PER_ENVELOPE)
      .optional(),
    fields: z.array(apiFieldSchema).min(1).max(MAX_API_FIELDS),
    metadata: metadataSchema.optional(),
    send: apiSendOptionsSchema.optional(),
    signers: z.array(apiSignerSchema).min(1).max(MAX_SIGNERS_PER_ENVELOPE),
    title: envelopeTitleSchema,
  })
  .superRefine((value, ctx) => {
    const refs = new Set<string>();

    for (const [index, signer] of value.signers.entries()) {
      if (refs.has(signer.ref)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Each signer needs its own ref.",
          path: ["signers", index, "ref"],
        });
      }

      refs.add(signer.ref);
    }

    for (const [index, field] of value.fields.entries()) {
      if (!refs.has(field.signer)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `No signer has the ref "${field.signer}".`,
          path: ["fields", index, "signer"],
        });
      }
    }
  });

export type ApiCreateEnvelopeInput = z.infer<typeof apiCreateEnvelopeSchema>;
export type ApiSendOptions = z.infer<typeof apiSendOptionsSchema>;

export type ApiActor = {
  apiKeyId: string;
  email: string;
  ipAddress: string | null;
  name: string;
  userAgent: string | null;
  userId: string;
};

/** The first message of a zod error, with where it was. */
export function describeZodError(error: z.ZodError): string {
  const issue = error.issues[0];

  if (!issue) {
    return "The request is not valid.";
  }

  const where = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";

  return `${where}${issue.message}`;
}

export async function sendEnvelopeForApi(
  actor: ApiActor,
  envelopeId: string,
  options: ApiSendOptions,
  database: DbPool = getDb(),
) {
  await sendDraftEnvelope(
    actor.userId,
    envelopeId,
    {
      apiKeyId: actor.apiKeyId,
      expiresInDays: options.expiresInDays,
      ipAddress: actor.ipAddress,
      reminderIntervalDays: options.reminderIntervalDays,
      senderEmail: actor.email,
      senderName: actor.name.trim() ? actor.name : actor.email,
      signatureLevel: options.signatureLevel,
      userAgent: actor.userAgent,
    },
    { database },
  );
}

/**
 * Creates a draft with its signers, copy recipients and fields, and sends it
 * if asked. Either all of it happens or none of it does: a draft that cannot
 * be completed (a field off its page, a send the install refuses) is deleted
 * again before the error is returned.
 */
export async function createEnvelopeForApi(
  actor: ApiActor,
  input: ApiCreateEnvelopeInput,
  sourcePdf: { body: Uint8Array; contentType: string; filename: string },
  database: DbPool = getDb(),
  options: {
    /** Called once the envelope is made, and sent if asked, for good. */
    onCreated?: (envelopeId: string) => Promise<void>;
  } = {},
): Promise<ApiEnvelope> {
  const draft = await createDraftEnvelope(
    actor.userId,
    { sourcePdf, title: input.title },
    { database },
  );
  const envelopeId = draft.envelope.id;

  try {
    for (const [index, field] of input.fields.entries()) {
      if (field.page > draft.envelope.pageCount) {
        throw new EnvelopeMutationError(
          `fields.${String(index)}.page: the document has ${String(draft.envelope.pageCount)} page(s).`,
          400,
        );
      }
    }

    const signers = await replaceDraftEnvelopeSigners(
      actor.userId,
      envelopeId,
      {
        copyRecipients: input.copyRecipients ?? [],
        signers: input.signers.map((signer, index) => ({
          accessCode: signer.accessCode,
          email: signer.email,
          name: signer.name,
          requireEmailCode: signer.requireEmailCode,
          signatureMeaning: signer.signatureMeaning,
          signOrder: index + 1,
        })),
      },
      database,
    );
    const idByEmail = new Map(
      signers.signers.map((signer) => [signer.email.toLowerCase(), signer.id]),
    );
    const idByRef = new Map<string, string>();

    for (const signer of input.signers) {
      const id = idByEmail.get(signer.email.toLowerCase());

      if (!id) {
        throw new Error("A signer that was just saved could not be found.");
      }

      idByRef.set(signer.ref, id);
      await database.query(
        `UPDATE signers SET api_ref = $1 WHERE id = $2 AND envelope_id = $3`,
        [signer.ref, id, envelopeId],
      );
    }

    await replaceDraftEnvelopeFields(
      actor.userId,
      envelopeId,
      {
        fields: input.fields.map((field) => ({
          groupId: field.groupId,
          height: field.height,
          label: field.label,
          options: field.options,
          page: field.page,
          required: field.required ?? true,
          signerId: idByRef.get(field.signer),
          type: field.type,
          width: field.width,
          x: field.x,
          y: field.y,
        })),
      },
      database,
    );
    await database.query(
      `UPDATE envelopes SET api_key_id = $1, api_metadata = $2 WHERE id = $3`,
      [actor.apiKeyId, input.metadata ?? null, envelopeId],
    );

    if (input.send) {
      await sendEnvelopeForApi(actor, envelopeId, input.send, database);
    }
  } catch (error) {
    await deleteDraftEnvelope(actor.userId, envelopeId, { database }).catch(
      (cleanupError: unknown) => {
        console.error(
          `Deleting the API draft ${envelopeId} after a failed create failed:`,
          cleanupError,
        );
      },
    );
    throw error;
  }

  await options.onCreated?.(envelopeId);

  const envelope = await getApiEnvelope(actor.userId, envelopeId, database);

  if (!envelope) {
    throw new Error(
      "An envelope that was just created could not be read back.",
    );
  }

  return envelope;
}

/** Sets what an envelope made from a template keeps for the API. */
export async function markEnvelopeAsApiMade(
  envelopeId: string,
  apiKeyId: string,
  metadata: Record<string, unknown> | null,
  database: DbExecutor = getDb(),
) {
  await database.query(
    `UPDATE envelopes SET api_key_id = $1, api_metadata = $2 WHERE id = $3`,
    [apiKeyId, metadata, envelopeId],
  );
}

type EnvelopeRow = {
  apiMetadata: Record<string, unknown> | null;
  completedAt: number | null;
  createdAt: number;
  declinedAt: number | null;
  evidenceKey: string | null;
  expiresAt: number | null;
  id: string;
  pageCount: number;
  sentAt: number | null;
  signatureLevel: string | null;
  signedPdfKey: string | null;
  status: EnvelopeStatus;
  title: string;
  voidedAt: number | null;
};

type SignerRow = {
  apiRef: string | null;
  declinedAt: number | null;
  declineReason: string | null;
  email: string;
  envelopeId: string;
  id: string;
  name: string;
  role: "cc" | "signer";
  signedAt: number | null;
  signOrder: number;
  status: SignerStatus;
  viewedAt: number | null;
};

const ENVELOPE_COLUMNS = `
  e.id,
  e.title,
  e.status,
  e.page_count AS "pageCount",
  e.signed_pdf_key AS "signedPdfKey",
  e.evidence_key AS "evidenceKey",
  e.sent_at AS "sentAt",
  e.completed_at AS "completedAt",
  e.declined_at AS "declinedAt",
  e.voided_at AS "voidedAt",
  e.expires_at AS "expiresAt",
  e.signature_level AS "signatureLevel",
  e.api_metadata AS "apiMetadata",
  e.created_at AS "createdAt"
`;

async function readSigners(
  envelopeIds: string[],
  database: DbExecutor,
): Promise<Map<string, SignerRow[]>> {
  const bySignerEnvelope = new Map<string, SignerRow[]>();

  if (envelopeIds.length === 0) {
    return bySignerEnvelope;
  }

  const rows = await queryMany<SignerRow>(
    database,
    `
      SELECT
        s.id,
        s.envelope_id AS "envelopeId",
        s.name,
        s.email,
        s.role,
        s.sign_order AS "signOrder",
        s.status,
        s.signed_at AS "signedAt",
        s.declined_at AS "declinedAt",
        s.decline_reason AS "declineReason",
        s.api_ref AS "apiRef",
        (
          SELECT min(a.created_at)
          FROM audit_events a
          WHERE a.envelope_id = s.envelope_id
            AND a.event = 'viewed'
            AND a.metadata->>'signerId' = s.id
            -- A corrected signer keeps the id but not the old person's view.
            AND lower(a.metadata->>'signerEmail') = lower(s.email)
        ) AS "viewedAt"
      FROM signers s
      WHERE s.envelope_id = ANY($1)
      ORDER BY s.envelope_id, s.sign_order, s.id
    `,
    [envelopeIds],
  );

  for (const row of rows) {
    const list = bySignerEnvelope.get(row.envelopeId) ?? [];

    list.push(row);
    bySignerEnvelope.set(row.envelopeId, list);
  }

  return bySignerEnvelope;
}

export function toApiEnvelope(
  row: EnvelopeRow,
  signers: SignerRow[],
  now: number = Math.floor(Date.now() / 1000),
): ApiEnvelope {
  const base = `/api/v1/envelopes/${encodeURIComponent(row.id)}/files`;
  const finished =
    row.status === "completed" ||
    row.status === "declined" ||
    row.status === "voided";

  return {
    completedAt: isoTime(row.completedAt),
    copyRecipients: signers
      .filter((signer) => signer.role === "cc")
      .map((signer) => ({
        email: signer.email,
        id: signer.id,
        name: signer.name,
      })),
    createdAt: isoTime(row.createdAt) ?? new Date(0).toISOString(),
    declinedAt: isoTime(row.declinedAt),
    expired:
      row.status === "sent" && row.expiresAt !== null && row.expiresAt <= now,
    expiresAt: isoTime(row.expiresAt),
    files: {
      certificate: finished ? `${base}/certificate` : null,
      signed: row.status === "completed" ? `${base}/signed` : null,
    },
    id: row.id,
    metadata: row.apiMetadata,
    object: "envelope",
    pageCount: row.pageCount,
    sentAt: isoTime(row.sentAt),
    signatureLevel: row.signatureLevel ?? "simple",
    signers: signers
      .filter((signer) => signer.role === "signer")
      .map((signer) => ({
        declinedAt: isoTime(signer.declinedAt),
        declineReason: signer.declineReason,
        email: signer.email,
        id: signer.id,
        name: signer.name,
        order: signer.signOrder,
        ref: signer.apiRef,
        signedAt: isoTime(signer.signedAt),
        status: signer.status,
        viewedAt: isoTime(signer.viewedAt),
      })),
    status: row.status,
    title: row.title,
    voidedAt: isoTime(row.voidedAt),
  };
}

/** One envelope the account can see, or null. */
export async function getApiEnvelope(
  userId: string,
  envelopeId: string,
  database: DbExecutor = getDb(),
): Promise<ApiEnvelope | null> {
  const row = await queryOne<EnvelopeRow>(
    database,
    `SELECT ${ENVELOPE_COLUMNS} FROM envelopes e WHERE e.id = $1 AND e.user_id = $2`,
    [envelopeId, userId],
  );

  if (!row) {
    return null;
  }

  const signers = await readSigners([row.id], database);

  return toApiEnvelope(row, signers.get(row.id) ?? []);
}

export function encodeCursor(createdAt: number, id: string): string {
  return Buffer.from(`${String(createdAt)}:${id}`, "utf8").toString(
    "base64url",
  );
}

export function decodeCursor(
  cursor: string,
): { createdAt: number; id: string } | null {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const separator = decoded.indexOf(":");

  if (separator <= 0) {
    return null;
  }

  const createdAt = Number(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);

  return Number.isSafeInteger(createdAt) && id.length > 0
    ? { createdAt, id }
    : null;
}

export const apiListQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
  status: z
    .enum(["draft", "sent", "completed", "declined", "voided"])
    .optional(),
});

/** The account's envelopes, newest first, a page at a time. */
export async function listApiEnvelopes(
  userId: string,
  query: z.infer<typeof apiListQuerySchema>,
  database: DbExecutor = getDb(),
): Promise<{ data: ApiEnvelope[]; nextCursor: string | null }> {
  const values: unknown[] = [userId];
  const clauses = ["e.user_id = $1"];

  if (query.status) {
    values.push(query.status);
    clauses.push(`e.status = $${String(values.length)}`);
  }

  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);

    if (!cursor) {
      throw new EnvelopeMutationError(
        "cursor: not a cursor this API gave out.",
        400,
      );
    }

    values.push(cursor.createdAt, cursor.id);
    clauses.push(
      `(e.created_at, e.id) < ($${String(values.length - 1)}, $${String(values.length)})`,
    );
  }

  values.push(query.limit + 1);

  const rows = await queryMany<EnvelopeRow>(
    database,
    `
      SELECT ${ENVELOPE_COLUMNS}
      FROM envelopes e
      WHERE ${clauses.join(" AND ")}
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT $${String(values.length)}
    `,
    values,
  );
  const page = rows.slice(0, query.limit);
  const signers = await readSigners(
    page.map((row) => row.id),
    database,
  );
  const last = page.at(-1);

  return {
    data: page.map((row) => toApiEnvelope(row, signers.get(row.id) ?? [])),
    nextCursor:
      rows.length > query.limit && last
        ? encodeCursor(last.createdAt, last.id)
        : null,
  };
}

type AuditRow = {
  actorEmail: string | null;
  actorType: string;
  createdAt: number;
  event: string;
  id: string;
  ipAddress: string | null;
  metadata: Record<string, unknown> | null;
};

/** The envelope's audit trail, oldest first, as the API returns it. */
export async function listApiEnvelopeEvents(
  userId: string,
  envelopeId: string,
  database: DbExecutor = getDb(),
) {
  const owner = await queryOne<{ id: string }>(
    database,
    `SELECT id FROM envelopes WHERE id = $1 AND user_id = $2`,
    [envelopeId, userId],
  );

  if (!owner) {
    return null;
  }

  const rows = await queryMany<AuditRow>(
    database,
    `
      SELECT
        id,
        event,
        actor_type AS "actorType",
        actor_email AS "actorEmail",
        ip_address AS "ipAddress",
        metadata,
        created_at AS "createdAt"
      FROM audit_events
      WHERE envelope_id = $1
      ORDER BY sequence ASC
    `,
    [envelopeId],
  );

  return rows.map((row) => ({
    actor: { email: row.actorEmail, type: row.actorType },
    at: isoTime(row.createdAt),
    event: row.event,
    id: row.id,
    ipAddress: row.ipAddress,
    metadata: row.metadata,
  }));
}
