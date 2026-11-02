import { createHash } from "node:crypto";
import { transaction } from "../../db.js";
import type { Pool } from "pg";
import { createId } from "@paralleldrive/cuid2";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { apiJson, canonicalJson, wireInteger } from "@kasitek-labs/server-support/json";
import { linkWhatsappContact } from "../customers.js";
import type {
  Row,
  WhatsappContactListQuery,
  WhatsappContactUpdateRequest,
} from "./types.js";
import { rowView } from "./types.js";
import { SQL } from "./contacts-sql.js";
import {
  bad,
  missing,
  conflict,
  internal,
  trimmed,
  json,
  normalizePhone,
  sanitizeTags,
  sanitizeListLabel,
  selectListContactRow,
  parseBoolLike,
  pickFirst,
  parseCsvTags,
  extractContactMetadata,
  sanitizeFilename,
  hasConfirmedImportConsent,
} from "./common.js";
export async function listContacts(
  pool: Pool,
  orgId: string,
  query: WhatsappContactListQuery = {},
): Promise<Row> {
  const limit = Math.max(1, Math.min(10000, Number(query.limit ?? 500)));
  const contacts = (
    await pool.query(SQL.list_contacts[0], [
      orgId,
      trimmed(query.q),
      query.opt_in ?? null,
      query.excluded ?? null,
      trimmed(query.tag),
      trimmed(query.location),
      trimmed(query.list_label),
      limit,
      BigInt.asIntN(64, BigInt(query.cursor ?? 0)),
    ])
  ).rows;
  const [total, opted, excluded, tags, lists] = await Promise.all(
    SQL.list_contacts.slice(1).map((sql) => pool.query(sql, [orgId])),
  );
  const tagOptions = [
    ...new Set<string>(
      tags!.rows.flatMap((row) => Object.values(row)[0] as string[]),
    ),
  ].sort((a, b) =>
    a.toLowerCase() < b.toLowerCase()
      ? -1
      : a.toLowerCase() > b.toLowerCase()
        ? 1
        : 0,
  );
  const count = (value: Row) => wireInteger(Object.values(value)[0] as string);
  return {
    contacts: contacts.map((row) => rowView("WhatsappListContactRow", row)),
    lists: lists!.rows.map((row) => ({
      label: row.list_label,
      totalContacts: wireInteger(row.total_contacts),
      primaryLocation: row.primary_location,
      metadataKeys: (row.metadata_keys ?? []).filter(
        (v: unknown) => v !== null,
      ),
    })),
    tagOptions,
    stats: {
      totalContacts: count(total!.rows[0]!),
      optedInContacts: count(opted!.rows[0]!),
      excludedContacts: count(excluded!.rows[0]!),
      filteredTotal: contacts.length
        ? wireInteger(contacts[0]!.total_count)
        : 0,
    },
  };
}
export async function exportContactList(
  pool: Pool,
  orgId: string,
  label: string,
): Promise<{
  bytes: Buffer;
  filename: string;
}> {
  const normalized = sanitizeListLabel(label),
    contacts = (
      await pool.query(SQL.export_contact_list[0], [orgId, normalized])
    ).rows;
  if (!contacts.length) throw missing("Contact list not found");
  const keys = [
    ...new Set<string>(
      contacts.flatMap((contact) =>
        contact.metadata !== null &&
        typeof contact.metadata === "object" &&
        !Array.isArray(contact.metadata)
          ? Object.keys(contact.metadata)
          : [],
      ),
    ),
  ].sort((a, b) =>
    a.toLowerCase() < b.toLowerCase()
      ? -1
      : a.toLowerCase() > b.toLowerCase()
        ? 1
        : 0,
  );
  const records = [
    [
      "phone",
      "fullName",
      "location",
      "tags",
      "notes",
      "optIn",
      "excluded",
      "listLabel",
      ...keys,
    ],
    ...contacts.map((contact) => [
      contact.phone,
      contact.full_name ?? "",
      contact.location ?? "",
      contact.tags.join(", "),
      contact.notes ?? "",
      String(contact.opt_in),
      String(contact.excluded),
      contact.list_label,
      ...keys.map((key) =>
        typeof contact.metadata?.[key] === "string"
          ? contact.metadata[key]
          : "",
      ),
    ]),
  ];
  return {
    bytes: Buffer.from(stringify(records, { record_delimiter: "\n" })),
    filename: sanitizeFilename(`${normalized}.csv`),
  };
}
export async function updateContact(
  pool: Pick<Pool, "query">,
  orgId: string,
  id: string,
  input: WhatsappContactUpdateRequest,
): Promise<Row> {
  const existing = await selectListContactRow(pool, orgId, id);
  if (!existing) throw missing("Contact not found");
  const phone = input.phone != null ? normalizePhone(input.phone) : null;
  if (phone === "") throw bad("Invalid phone number format");
  if (
    phone &&
    (
      await pool.query(SQL.update_contact[0], [
        orgId,
        phone,
        existing.contact_id,
      ])
    ).rows.length
  )
    throw conflict("A contact with this phone already exists");
  const label =
    input.list_label != null ? sanitizeListLabel(input.list_label) : null;
  const optIn = input.opt_in ?? null,
    source = optIn !== null ? "dashboard" : existing.opt_in_source,
    date =
      optIn === true
        ? (existing.opt_in_date ?? new Date())
        : optIn === false
          ? null
          : existing.opt_in_date;
  if (phone)
    await pool.query(SQL.update_contact[1], [
      phone,
      existing.contact_id,
      orgId,
    ]);
  if (
    label &&
    (
      await pool.query(SQL.update_contact[2], [
        orgId,
        existing.contact_id,
        label,
        id,
      ])
    ).rows.length
  )
    throw conflict("This contact is already in that list");
  await pool.query(SQL.update_contact[3], [
    trimmed(input.full_name),
    trimmed(input.location),
    input.tags != null ? sanitizeTags(input.tags) : null,
    trimmed(input.notes),
    label,
    json(input.metadata),
    optIn,
    source,
    date?.toISOString() ?? null,
    input.excluded ?? null,
    id,
    orgId,
  ]);
  const updated = await selectListContactRow(pool, orgId, id);
  if (!updated) throw internal("Failed to reload contact");
  await linkWhatsappContact(
    pool,
    orgId,
    updated.contact_id,
    updated.phone,
    updated.full_name,
  );
  return { contact: rowView("WhatsappListContactRow", updated) };
}
const MARKER = "_kasitek_agent_contact_update_idempotency_key";
export async function updateAgentContact(
  pool: Pool,
  orgId: string,
  id: string,
  input: WhatsappContactUpdateRequest,
  idempotencyKey: string,
  options: { expectedSnapshot?: string } = {},
): Promise<Row> {
  const key = idempotencyKey.trim();
  if (Buffer.byteLength(key) < 8 || Buffer.byteLength(key) > 240)
    throw bad("A valid agent contact idempotency key is required");
  if (input.metadata != null && (typeof input.metadata !== "object" || Array.isArray(input.metadata)))
    throw bad("Agent contact metadata must be a JSON object");
  return transaction(pool, async tx => {
    const revision = (await tx.query(`SELECT m."updatedAt" AS "membershipRevision",c."updatedAt" AS "contactRevision"
      FROM "WhatsappContactListMembership" m JOIN "WhatsappContact" c ON c.id=m."contactId" AND c."orgId"=m."orgId"
      WHERE m.id=$1 AND m."orgId"=$2 FOR UPDATE OF m,c`, [id, orgId])).rows[0];
    if (!revision) throw missing("Contact not found");
    const existing = (await selectListContactRow(tx, orgId, id))!;
    if (existing.metadata?.[MARKER] === key) {
      const contact = rowView("WhatsappListContactRow", existing);
      if (contact.metadata && typeof contact.metadata === "object") delete contact.metadata[MARKER];
      return { contact };
    }
    if (options.expectedSnapshot && createHash("sha256").update(canonicalJson(JSON.parse(apiJson(revision)))).digest("hex") !== options.expectedSnapshot)
      throw conflict("The reviewed contact changed. Review it again before updating.");
    const metadata = { ...((input.metadata as object) ?? (existing.metadata as object)), [MARKER]: key };
    const result = await updateContact(tx, orgId, id, { ...input, metadata });
    if (result.contact.metadata && typeof result.contact.metadata === "object") delete result.contact.metadata[MARKER];
    return result;
  });
}
export interface ContactImportInput {
  bytes: Buffer;
  defaultOptIn?: boolean;
  consentConfirmed?: boolean;
  listLabel?: string | null;
}
export async function importContacts(
  pool: Pool,
  userId: string,
  orgId: string,
  input: ContactImportInput,
): Promise<Row> {
  if (!input.bytes.length)
    throw bad("CSV file is required in form-data field: file");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
  } catch {
    throw bad("CSV file must be valid UTF-8 text");
  }
  let records: Record<string, string>[];
  const invalid: Row[] = [];
  let totalRows = 0;
  try {
    const raw = parse(text, {
      trim: true,
      skip_empty_lines: true,
      relax_column_count: true,
      info: true,
    }) as unknown as {
      record: string[];
      info: {
        error?: Error;
      };
    }[];
    if (!raw.length || !raw[0]!.record.length) throw bad("CSV has no rows");
    const headers = raw.shift()!.record;
    records = [];
    for (const record of raw) {
      const index = totalRows++;
      if (record.record.length !== headers.length) {
        invalid.push({ index, error: "Failed to parse CSV row", row: {} });
        records.push({});
        continue;
      }
      records.push(
        Object.fromEntries(
          headers.map((header, i) => [header, record.record[i]!]),
        ),
      );
    }
  } catch (error) {
    if (error instanceof Error && error.name === "ApiError") throw error;
    throw bad("Failed to parse CSV headers");
  }
  const now = new Date(),
    deduped = new Map<string, Row>();
  for (const [index, row] of records.entries()) {
    if (invalid.some((value) => value.index === index)) continue;
    const raw = pickFirst(row, [
      "phone",
      "Phone",
      "mobile",
      "Mobile",
      "whatsapp",
      "whatsappNumber",
      "number",
    ]);
    if (raw === null) {
      invalid.push({ index, error: "Missing phone column", row });
      continue;
    }
    const phone = normalizePhone(raw);
    if (!phone) {
      invalid.push({ index, error: `Invalid phone format: ${raw}`, row });
      continue;
    }
    const explicit = pickFirst(row, [
        "optIn",
        "opt_in",
        "optedIn",
        "subscribed",
        "consent",
      ]),
      optIn = explicit !== null ? parseBoolLike(explicit) : null;
    deduped.set(phone, {
      fullName: pickFirst(row, ["fullName", "name", "Name", "contactName"]),
      location: pickFirst(row, ["location", "city", "province", "region"]),
      tags: parseCsvTags(pickFirst(row, ["tags", "segment", "groups"])),
      notes: pickFirst(row, ["notes", "note"]),
      optIn: optIn ?? input.defaultOptIn ?? false,
      optInSource:
        pickFirst(row, ["optInSource", "consentSource"]) ??
        (optIn !== null ? "csv-import" : null),
      optInDate: optIn === true || input.defaultOptIn ? now : null,
      label: sanitizeListLabel(
        pickFirst(row, ["listLabel", "list"]) ?? input.listLabel,
      ),
      metadata: extractContactMetadata(row),
    });
  }
  if (!deduped.size && !invalid.length) throw bad("CSV has no rows");
  if (
    !hasConfirmedImportConsent(
      [...deduped.values()].some((contact) => contact.optIn),
      input.consentConfirmed ?? false,
    )
  )
    throw bad(
      "Confirm that you have permission to record consent before importing opted-in contacts",
    );
  const existing = deduped.size
      ? (await pool.query(SQL.import_contacts[0], [orgId, [...deduped.keys()]]))
          .rows
      : [],
    existingByPhone = new Map(existing.map((row) => [row.phone, row])),
    ids = existing.map((row) => row.id),
    memberships = ids.length
      ? (await pool.query(SQL.import_contacts[1], [orgId, ids])).rows
      : [],
    membershipByIdentity = new Map(
      memberships.map((row) => [
        `${row.contact_id}\0${row.list_label}`,
        row.id,
      ]),
    );
  let created = 0,
    updated = 0;
  for (const [phone, contact] of deduped) {
    const previous = existingByPhone.get(phone),
      id = previous?.id ?? createId();
    if (previous)
      await pool.query(SQL.import_contacts[2], [
        contact.fullName,
        contact.location,
        contact.optIn,
        contact.optInSource,
        contact.optInDate?.toISOString() ?? null,
        id,
      ]);
    else
      await pool.query(SQL.import_contacts[3], [
        id,
        userId,
        orgId,
        phone,
        contact.fullName,
        [],
        contact.location,
        null,
        contact.label,
        null,
        contact.optIn,
        contact.optInSource,
        contact.optInDate?.toISOString() ?? null,
      ]);
    await linkWhatsappContact(pool, orgId, id, phone, contact.fullName);
    const membership = membershipByIdentity.get(`${id}\0${contact.label}`);
    if (membership) {
      await pool.query(SQL.import_contacts[4], [
        contact.fullName,
        contact.location,
        sanitizeTags(contact.tags),
        contact.notes,
        json(contact.metadata),
        contact.optIn,
        contact.optInSource,
        contact.optIn
          ? ((previous?.opt_in_date ?? contact.optInDate)?.toISOString() ??
            null)
          : null,
        membership,
      ]);
      updated++;
    } else {
      await pool.query(SQL.import_contacts[5], [
        createId(),
        userId,
        orgId,
        id,
        contact.label,
        contact.fullName,
        sanitizeTags(contact.tags),
        contact.location,
        json(contact.metadata),
        contact.optIn,
        contact.optInSource,
        contact.optInDate?.toISOString() ?? null,
        contact.notes,
      ]);
      created++;
    }
  }
  return {
    summary: {
      totalRows,
      validRows: created + updated,
      invalidRows: invalid.length,
      created,
      updated,
    },
    invalidRows: invalid.sort((a, b) => a.index - b.index).slice(0, 100),
  };
}
export async function renameContactList(
  pool: Pool,
  orgId: string,
  label: string,
  nextLabel: string | null | undefined,
): Promise<Row> {
  const current = sanitizeListLabel(label),
    next = sanitizeListLabel(nextLabel);
  if (current === next)
    return { label: next, renamedContacts: 0, updatedCampaigns: 0 };
  const rows = [];
  for (const sql of SQL.rename_contact_list)
    rows.push(await pool.query(sql, [next, orgId, current]));
  return {
    label: next,
    renamedContacts: rows[0]!.rowCount ?? 0,
    updatedCampaigns: rows[2]!.rowCount ?? 0,
  };
}
export async function deleteContactList(
  pool: Pool,
  orgId: string,
  label: string,
): Promise<Row> {
  const current = sanitizeListLabel(label);
  if (
    BigInt(
      Object.values(
        (await pool.query(SQL.delete_contact_list[0], [orgId, current]))
          .rows[0]!,
      )[0] as string,
    ) > 0n
  )
    throw conflict("This list is still attached to active campaigns");
  const ids = (
    await pool.query(SQL.delete_contact_list[1], [orgId, current])
  ).rows.map((row) => row.contactId);
  const result = await pool.query(SQL.delete_contact_list[2], [orgId, current]);
  if (ids.length)
    await pool.query(SQL.delete_contact_list[3], [orgId, ids, current]);
  return { label: current, deletedContacts: result.rowCount ?? 0 };
}
