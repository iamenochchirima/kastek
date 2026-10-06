import type { Pool } from "pg";
import { createId } from "@paralleldrive/cuid2";
import { decryptSocialSecret } from "../../integrations/crypto.js";
import type { Row, WhatsappTemplateCreateRequest } from "./types.js";
import { rowView } from "./types.js";
import { SQL } from "./templates-sql.js";
import {
  GRAPH_BASE,
  getConnectionRowForOrg,
  fetchGraphJson,
  mapTemplateStatus,
  mapTemplateCategory,
  variablesCount,
  trimmed,
  json,
  bad,
  missing,
  type ProviderOptions,
} from "./common.js";
export async function syncConnectionTemplates(
  pool: Pool,
  userId: string,
  orgId: string,
  id: string,
  options: ProviderOptions,
): Promise<Row> {
  const connection = await getConnectionRowForOrg(pool, orgId, id);
  if (!connection) throw missing("Connection not found");
  const token = decryptSocialSecret(
      options.config,
      connection.access_token_encrypted,
    ),
    url = `${options.graphBase ?? GRAPH_BASE}/${connection.waba_id}/message_templates?fields=name,language,status,category,components&limit=250&access_token=${encodeURIComponent(token)}`;
  const response = await fetchGraphJson(url, {}, options),
    templates = response.data ?? [];
  let synced = 0;
  for (const template of templates) {
    const category = mapTemplateCategory(template.category);
    if (category === null || template.name == null || template.language == null)
      continue;
    const part = (type: string) =>
      (template.components ?? []).find((part: Row) => part.type === type);
    const header = part("HEADER")?.text ?? null,
      body = part("BODY")?.text ?? null,
      footer = part("FOOTER")?.text ?? null,
      buttons = part("BUTTONS")?.buttons ?? null;
    await pool.query(SQL.sync_connection_templates[0], [
      createId(),
      userId,
      orgId,
      id,
      template.name,
      template.language,
      category,
      header,
      body,
      footer,
      json(buttons),
      variablesCount(body),
      mapTemplateStatus(template.status),
    ]);
    synced++;
  }
  return { connectionId: id, fetched: templates.length, synced };
}
export async function createTemplate(
  pool: Pool,
  userId: string,
  orgId: string,
  input: WhatsappTemplateCreateRequest,
  options: ProviderOptions,
): Promise<Row> {
  const id = input.connection_id ?? "",
    connection = await getConnectionRowForOrg(pool, orgId, id);
  if (!connection) throw missing("WhatsApp connection not found");
  const name = input.template_name ?? "",
    language = input.language ?? "",
    body = input.body ?? "",
    header = trimmed(input.header),
    footer = trimmed(input.footer);
  if (!name.trim() || !language.trim() || !body.trim())
    throw bad("Template name, language, and body are required");
  const normalized = Array.from(name.trim().toLowerCase())
      .map((char) => (/^[a-z0-9_]$/.test(char) ? char : "_"))
      .join(""),
    category = mapTemplateCategory(input.category ?? "MARKETING");
  if (category === null) throw bad("Invalid template category");
  const token = decryptSocialSecret(
      options.config,
      connection.access_token_encrypted,
    ),
    components = [
      ...(header ? [{ type: "HEADER", format: "TEXT", text: header }] : []),
      { type: "BODY", text: body.trim() },
      ...(footer ? [{ type: "FOOTER", text: footer }] : []),
    ];
  const response = await fetchGraphJson(
    `${options.graphBase ?? GRAPH_BASE}/${connection.waba_id}/message_templates`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: normalized,
        category,
        language: language.trim(),
        components,
      }),
    },
    options,
  );
  await pool.query(SQL.create_template[0], [
    createId(),
    userId,
    orgId,
    id,
    normalized,
    language.trim(),
    category,
    header,
    body.trim(),
    footer,
    variablesCount(body.trim()),
    mapTemplateStatus(response.status),
  ]);
  const template = (
    await pool.query(SQL.create_template[1], [
      orgId,
      normalized,
      language.trim(),
    ])
  ).rows[0]!;
  return {
    template: rowView("WhatsappTemplateRow", template),
    metaTemplateId: typeof response.id === "string" ? response.id : null,
    status: typeof response.status === "string" ? response.status : "PENDING",
  };
}
export async function listTemplates(
  pool: Pool,
  orgId: string,
  status?: string | null,
): Promise<Row> {
  const rows = (
    await pool.query(SQL.list_templates[0], [
      orgId,
      trimmed(status)?.toUpperCase() ?? null,
    ])
  ).rows;
  return {
    templates: rows.map((row) => ({
      id: row.id,
      templateName: row.template_name,
      language: row.language,
      category: row.category,
      status: row.status,
      variablesCount: row.variables_count,
      header: row.header,
      body: row.body,
      footer: row.footer,
      buttons: row.buttons,
      lastSynced: row.last_synced,
      connectionId: row.connection_id,
      connectionLabel: row.connection_label ?? "-",
    })),
  };
}
