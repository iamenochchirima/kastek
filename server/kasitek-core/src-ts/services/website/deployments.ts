import { createId } from "@paralleldrive/cuid2";
import type { Pool } from "pg";
import type { CoreConfig } from "../../config.js";
import { ApiError } from "../../error.js";
import { canonicalJson } from "@kasitek/server-support/json";
import { getContentMediaPreview } from "../social/media.js";
import { WEBSITE_SQL as sql } from "./sql.js";
export type Row = Record<string, any>;
export interface DeploymentInput {
  allowedOrigins?: string[] | null;
  displayName?: string | null;
  welcomeText?: string | null;
  launcherPosition?: string | null;
  colorPreset?: string | null;
  appearance?: AppearanceInput | null;
  avatarUrl?: string | null;
  privacyPolicyUrl?: string | null;
}
export interface AppearanceInput {
  primaryColor?: string | null;
  launcherSize?: number | null;
  windowWidth?: number | null;
  windowHeight?: number | null;
  borderRadius?: number | null;
  launcherOffset?: number | null;
  showBranding?: boolean | null;
}
export const bad = (message: string) =>
  new ApiError(400, "bad_request", message);
export const missing = (kind = "deployment") =>
  new ApiError(404, "not_found", `Website Chat ${kind} not found`);
export function camel(row: Row): Row {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
      value,
    ]),
  );
}
export function normalizeOrigin(value: string): string {
  const raw = value.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw bad("Allowed origins must be full http(s) origins");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    raw.includes("?") ||
    raw.includes("#")
  )
    throw bad("Allowed origins must be full http(s) origins without a path");
  return url.origin;
}
export function normalizeOrigins(values?: string[] | null): string[] {
  const valuesOut = [...new Set((values ?? []).map(normalizeOrigin))].sort();
  if (valuesOut.length > 30)
    throw bad("A website deployment can have at most 30 allowed origins");
  return valuesOut;
}
export function optionalUrl(
  value: string | null | undefined,
  field: string,
): string | null {
  const clean = value?.trim() || null;
  if (clean) {
    let url: URL;
    try {
      url = new URL(clean);
    } catch {
      throw bad(`${field} must be a valid http(s) URL`);
    }
    if (!["http:", "https:"].includes(url.protocol))
      throw bad(`${field} must be a valid http(s) URL`);
  }
  return clean;
}
function short(
  value: string | null | undefined,
  field: string,
  max: number,
): string | null {
  const clean = value?.trim() || null;
  if (clean && Buffer.byteLength(clean) > max)
    throw bad(`${field} must be at most ${max} characters`);
  return clean;
}
export function normalizeAppearance(
  input: AppearanceInput | null | undefined,
  preset: string,
): Row {
  const colors: Record<string, string> = {
    violet: "#7c3aed",
    emerald: "#059669",
    blue: "#2563eb",
    slate: "#334155",
  };
  const color = input?.primaryColor?.trim() || colors[preset] || "#3730a3";
  if (!/^#(?:[a-fA-F0-9]{3}|[a-fA-F0-9]{6})$/.test(color))
    throw bad("Appearance primaryColor must be a hex colour such as #3730a3");
  const range = (
    key: keyof AppearanceInput,
    min: number,
    max: number,
    fallback: number,
  ) => {
    const value = input?.[key] ?? fallback;
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < min ||
      value > max
    )
      throw bad(`Appearance ${key} must be between ${min} and ${max}`);
    return value;
  };
  return {
    primaryColor: color.toLowerCase(),
    launcherSize: range("launcherSize", 44, 96, 56),
    windowWidth: range("windowWidth", 300, 600, 390),
    windowHeight: range("windowHeight", 360, 800, 620),
    borderRadius: range("borderRadius", 0, 28, 16),
    launcherOffset: range("launcherOffset", 8, 48, 16),
    showBranding: input?.showBranding ?? true,
  };
}
function position(value: string): string {
  if (!["bottom-right", "bottom-left"].includes(value))
    throw bad("Invalid launcher position");
  return value;
}
function preset(value: string): string {
  if (!["indigo", "violet", "emerald", "blue", "slate"].includes(value))
    throw bad("Invalid colour preset");
  return value;
}
export function normalizeWebsiteDeploymentInput(
  input: DeploymentInput,
): unknown[] {
  const color = preset(input.colorPreset ?? "indigo");
  return [
    normalizeOrigins(input.allowedOrigins),
    short(input.displayName, "Display name", 100),
    short(input.welcomeText, "Welcome text", 500),
    position(input.launcherPosition ?? "bottom-right"),
    color,
    canonicalJson(normalizeAppearance(input.appearance, color)),
    optionalUrl(input.avatarUrl, "Avatar URL"),
    optionalUrl(input.privacyPolicyUrl, "Privacy policy URL"),
  ];
}
async function one(
  pool: Pool,
  query: string,
  args: unknown[],
  kind = "deployment",
): Promise<Row> {
  const row = (await pool.query(query, args)).rows[0];
  if (!row) throw missing(kind);
  return camel(row);
}
export async function listAgentWebsiteDeployments(
  pool: Pool,
  org: string,
  installation: string,
): Promise<Row[]> {
  return (
    await pool.query(sql.list_agent_website_deployments[0], [org, installation])
  ).rows.map(camel);
}
export async function deleteAgentWebsiteDeployments(
  pool: Pool,
  org: string,
  installations: string[],
): Promise<number> {
  if (!installations.length) return 0;
  return (
    (
      await pool.query(sql.delete_agent_website_deployments[0], [
        org,
        installations,
      ])
    ).rowCount ?? 0
  );
}
export async function setAgentWebsiteDeploymentStatus(
  pool: Pool,
  org: string,
  installation: string,
  id: string,
  status: string,
): Promise<Row> {
  if (!["ACTIVE", "PAUSED", "REVOKED"].includes(status))
    throw bad("Invalid Website Chat status");
  return one(pool, sql.set_agent_website_deployment_status[0], [
    status,
    status === "ACTIVE",
    status === "PAUSED",
    status === "REVOKED",
    id,
    org,
    installation,
  ]);
}
export async function createAgentWebsiteDeployment(
  pool: Pool,
  org: string,
  installation: string,
  connection: string,
  publicId: string,
  actor: string,
  input: DeploymentInput,
): Promise<Row> {
  return one(pool, sql.create_agent_website_deployment[0], [
    createId(),
    publicId,
    org,
    installation,
    connection,
    ...normalizeWebsiteDeploymentInput(input),
    actor,
  ]);
}
export async function updateAgentWebsiteDeployment(
  pool: Pool,
  org: string,
  installation: string,
  id: string,
  input: DeploymentInput,
): Promise<Row> {
  return one(pool, sql.update_agent_website_deployment[0], [
    input.allowedOrigins == null
      ? null
      : normalizeOrigins(input.allowedOrigins),
    short(input.displayName, "Display name", 100),
    short(input.welcomeText, "Welcome text", 500),
    input.launcherPosition == null ? null : position(input.launcherPosition),
    input.colorPreset == null ? null : preset(input.colorPreset),
    input.appearance == null
      ? null
      : canonicalJson(
          normalizeAppearance(input.appearance, input.colorPreset ?? "indigo"),
        ),
    optionalUrl(input.avatarUrl, "Avatar URL"),
    optionalUrl(input.privacyPolicyUrl, "Privacy policy URL"),
    id,
    org,
    installation,
  ]);
}
export async function publicAgentWebsiteDeployment(
  pool: Pool,
  id: string,
  origin: string,
  allowShareOrigin: boolean,
): Promise<Row> {
  return one(pool, sql.public_agent_website_deployment[0], [
    id.trim(),
    normalizeOrigin(origin),
    allowShareOrigin,
  ]);
}
export async function createAgentWebsiteVisitorSession(
  pool: Pool,
  deployment: Row,
  origin: string,
): Promise<Row> {
  const publicId = `wvs_${createId()}`;
  return one(
    pool,
    sql.create_agent_website_visitor_session[0],
    [
      createId(),
      publicId,
      deployment.id,
      normalizeOrigin(origin),
      `website:${publicId}`,
      `website:${deployment.publicId}:${publicId}`,
      new Date(Date.now() + 86400000),
    ],
    "session",
  );
}
export async function activeAgentWebsiteVisitorSession(
  pool: Pool,
  id: string,
  origin: string,
): Promise<Row> {
  return one(
    pool,
    sql.active_agent_website_visitor_session[0],
    [id.trim(), normalizeOrigin(origin)],
    "session",
  );
}
export async function recordAgentWebsiteDelivery(
  pool: Pool,
  org: string,
  conversation: string,
  eventKey: string,
  text: string,
  media: unknown[],
  ui?: unknown,
): Promise<Row | null> {
  const session = (
    await pool.query(sql.record_agent_website_delivery[0], [
      conversation.trim(),
      org,
    ])
  ).rows[0];
  if (!session) return null;
  const content: Row = { version: "1", text, media };
  if (ui && typeof ui === "object" && !Array.isArray(ui)) {
    const object = ui as Row;
    if (
      object.version === "1" &&
      Array.isArray(object.blocks) &&
      object.blocks.length <= 4 &&
      Buffer.byteLength(canonicalJson(ui)) <= 32000
    )
      content.ui = ui;
  }
  return one(pool, sql.record_agent_website_delivery[1], [
    createId(),
    session.id,
    eventKey,
    text,
    canonicalJson(content),
  ]);
}
export async function listAgentWebsiteDeliveries(
  pool: Pool,
  session: Row,
  after?: string | null,
): Promise<Row[]> {
  return (
    await pool.query(sql.list_agent_website_deliveries[0], [
      session.id,
      after ?? null,
    ])
  ).rows.map(camel);
}
export async function addAgentWebsiteDeliveryPreviews(
  pool: Pool,
  config: CoreConfig,
  org: string,
  deliveries: Row[],
): Promise<void> {
  for (const delivery of deliveries) {
    const media = delivery.messageContent?.media;
    if (!Array.isArray(media)) continue;
    for (const item of media) {
      if (
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        typeof item.assetId === "string"
      ) {
        const [, url] = await getContentMediaPreview(
          pool,
          config,
          org,
          item.assetId,
        );
        item.previewUrl = url;
      }
    }
  }
}
export async function agentWebsiteDeploymentOrgId(
  pool: Pool,
  id: string,
): Promise<string> {
  const row = (await pool.query(sql.agent_website_deployment_org_id[0], [id]))
    .rows[0];
  if (!row) throw missing();
  return row.orgId;
}
