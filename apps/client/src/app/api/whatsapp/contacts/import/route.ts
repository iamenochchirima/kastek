import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parse } from "csv-parse/sync";
import { normalizeToE164 } from "@/lib/whatsapp/phone";

export const runtime = "nodejs";

type CsvRow = Record<string, string | undefined>;
type NormalizedContactRow = {
  phone: string;
  fullName: string | null;
  location: string | null;
  tags: string[];
  notes: string | null;
  optIn: boolean;
  optInSource: string | null;
  optInDate: Date | null;
};

function pickFirst(row: CsvRow, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (value && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function parseTags(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function parseOptIn(value: string | undefined): boolean | null {
  if (!value) return null;

  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;

  return null;
}

export async function POST(req: Request) {
  try {
    const session = await auth();
    const userId = session?.user?.id;

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const formData = await req.formData();
    const file = formData.get("file");
    const defaultOptIn = parseOptIn(String(formData.get("defaultOptIn") || "")) ?? false;

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "CSV file is required in form-data field: file" },
        { status: 400 }
      );
    }

    const csvText = await file.text();
    const rows = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as CsvRow[];

    if (!rows.length) {
      return NextResponse.json({ error: "CSV has no rows" }, { status: 400 });
    }

    const invalidRows: Array<{ index: number; error: string; row: CsvRow }> = [];
    const validRows: NormalizedContactRow[] = [];

    rows.forEach((row, index) => {
        const phoneRaw = pickFirst(row, [
          "phone",
          "Phone",
          "mobile",
          "Mobile",
          "whatsapp",
          "whatsappNumber",
          "number",
        ]);

        if (!phoneRaw) {
          invalidRows.push({ index, error: "Missing phone column", row });
          return;
        }

        const phone = normalizeToE164(phoneRaw);
        if (!phone) {
          invalidRows.push({ index, error: `Invalid phone format: ${phoneRaw}`, row });
          return;
        }

        const explicitOptIn = parseOptIn(
          pickFirst(row, ["optIn", "opt_in", "optedIn", "subscribed", "consent"])
        );

        validRows.push({
          phone,
          fullName: pickFirst(row, ["fullName", "name", "Name", "contactName"]) || null,
          location: pickFirst(row, ["location", "city", "province", "region"]) || null,
          tags: parseTags(pickFirst(row, ["tags", "segment", "groups"])),
          notes: pickFirst(row, ["notes", "note"]) || null,
          optIn: explicitOptIn ?? defaultOptIn,
          optInSource:
            pickFirst(row, ["optInSource", "consentSource"]) ||
            (explicitOptIn !== null ? "csv-import" : null),
          optInDate: explicitOptIn === true || defaultOptIn ? new Date() : null,
        });
    });

    const uniqueRowsByPhone = new Map<string, (typeof validRows)[number]>();
    for (const row of validRows) {
      uniqueRowsByPhone.set(row.phone, row);
    }

    const dedupedRows = Array.from(uniqueRowsByPhone.values());

    const existingContacts = dedupedRows.length
      ? await prisma.whatsappContact.findMany({
          where: {
            userId,
            phone: {
              in: dedupedRows.map((row) => row.phone),
            },
          },
          select: {
            id: true,
            phone: true,
            optIn: true,
            optInDate: true,
          },
        })
      : [];

    const existingByPhone = new Map(existingContacts.map((contact) => [contact.phone, contact]));

    const toCreate = dedupedRows.filter((row) => !existingByPhone.has(row.phone));
    const toUpdate = dedupedRows.filter((row) => existingByPhone.has(row.phone));

    if (toCreate.length) {
      await prisma.whatsappContact.createMany({
        data: toCreate.map((row) => ({
          userId,
          phone: row.phone,
          fullName: row.fullName,
          location: row.location,
          tags: row.tags,
          notes: row.notes,
          optIn: row.optIn,
          optInSource: row.optInSource,
          optInDate: row.optInDate,
          excluded: false,
        })),
      });
    }

    await Promise.all(
      toUpdate.map((row) => {
        const existing = existingByPhone.get(row.phone);

        return prisma.whatsappContact.update({
          where: {
            userId_phone: {
              userId,
              phone: row.phone,
            },
          },
          data: {
            fullName: row.fullName,
            location: row.location,
            tags: row.tags,
            notes: row.notes,
            optIn: row.optIn,
            optInSource: row.optInSource,
            // Keep original opt-in date if already opted-in and no stronger new date is available.
            optInDate: row.optIn ? existing?.optInDate || row.optInDate : null,
          },
        });
      })
    );

    return NextResponse.json({
      summary: {
        totalRows: rows.length,
        validRows: dedupedRows.length,
        invalidRows: invalidRows.length,
        created: toCreate.length,
        updated: toUpdate.length,
      },
      invalidRows: invalidRows.slice(0, 100),
    });
  } catch (error) {
    if (error instanceof Error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json(
      { error: "Failed to import contacts" },
      { status: 500 }
    );
  }
}
