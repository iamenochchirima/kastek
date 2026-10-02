import type { Pool } from "pg";
import type { FastifyRequest } from "fastify";
import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import {
  mkdir,
  writeFile,
  readFile,
  stat,
  unlink,
  access,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createId } from "@paralleldrive/cuid2";
import { canonicalJson, wireInteger } from "@kasitek/server-support/json";
import type { CoreConfig } from "../../config.js";
import { ApiError } from "../../error.js";
import { transaction } from "../../db.js";
import { bad, missing, internal, trimmed } from "./common.js";
import { SQL } from "./media-sql.js";
export interface ContentMediaAssetView {
  id: string;
  kind: string;
  mimeType: string;
  fileName: string | null;
  byteSize: number | bigint;
  checksum: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  processingStatus: string;
  scanStatus: string;
  createdAt: string;
}
export interface ContentMediaBytesUpload {
  fileName?: string | null;
  mimeType: string;
  bytes: Buffer;
  source: string;
  sourceKey?: string | null;
}
export interface StoredContentMedia {
  bytes: Buffer;
  mime_type: string;
  checksum: string | null;
}
interface UploadFields {
  fileName: string | null;
  mimeType: string | null;
  bytes: Buffer;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}
interface DownloadRow {
  storage_key: string;
  mime_type: string;
  file_name: string | null;
  checksum: string | null;
  processing_status: string;
  scan_status: string;
}
export interface MediaDownload {
  bytes: Buffer;
  mimeType: string;
  headers: Record<string, string>;
}
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024,
  MAX_VIDEO_BYTES = 512 * 1024 * 1024,
  MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const conflict = (message: string) => new ApiError(409, "conflict", message);
export function mediaKind(mime: string): string | null {
  return mime.startsWith("image/")
    ? "IMAGE"
    : mime.startsWith("video/")
      ? "VIDEO"
      : mime.startsWith("audio/") || mime === "application/ogg"
        ? "AUDIO"
        : null;
}
const FORMATS: Record<string, string[]> = {
  IMAGE: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  VIDEO: ["video/mp4", "video/webm", "video/quicktime"],
  AUDIO: [
    "audio/aac",
    "audio/flac",
    "audio/mp4",
    "audio/m4a",
    "audio/mpeg",
    "audio/ogg",
    "audio/opus",
    "audio/wav",
    "audio/webm",
    "application/ogg",
  ],
};
export function matchesFileSignature(mime: string, bytes: Buffer): boolean {
  const starts = (value: Buffer | string) =>
    bytes.subarray(0, Buffer.byteLength(value)).equals(Buffer.from(value));
  switch (mime) {
    case "image/jpeg":
      return starts(Buffer.from([255, 216, 255]));
    case "image/png":
      return starts(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case "image/webp":
      return (
        bytes.length >= 12 &&
        starts("RIFF") &&
        bytes.subarray(8, 12).toString() === "WEBP"
      );
    case "image/gif":
      return starts("GIF87a") || starts("GIF89a");
    case "video/mp4":
    case "video/quicktime":
    case "audio/mp4":
    case "audio/m4a":
      return bytes.length >= 12 && bytes.subarray(4, 8).toString() === "ftyp";
    case "video/webm":
    case "audio/webm":
      return starts(Buffer.from([26, 69, 223, 163]));
    case "audio/aac":
      return bytes.length >= 2 && bytes[0] === 255 && (bytes[1]! & 246) === 240;
    case "audio/flac":
      return starts("fLaC");
    case "audio/mpeg":
      return (
        starts("ID3") ||
        (bytes.length >= 2 && bytes[0] === 255 && (bytes[1]! & 224) === 224)
      );
    case "audio/ogg":
    case "audio/opus":
    case "application/ogg":
      return starts("OggS");
    case "audio/wav":
      return (
        bytes.length >= 12 &&
        starts("RIFF") &&
        bytes.subarray(8, 12).toString() === "WAVE"
      );
    default:
      return false;
  }
}
export function safeFileName(value: string | null | undefined): string | null {
  const raw = trimmed(value);
  if (!raw || raw.endsWith("/")) return null;
  const name = path.basename(raw);
  const sanitized = Array.from(name)
    .map((character) => (/^[A-Za-z0-9._-]$/.test(character) ? character : "_"))
    .join("");
  return sanitized || null;
}
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/mp4": "mp4",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "application/ogg": "ogg",
  "audio/opus": "opus",
  "audio/wav": "wav",
  "audio/webm": "webm",
};
export function storagePath(config: CoreConfig, key: string): string {
  if (path.isAbsolute(key) || key.split("/").includes(".."))
    throw internal("Invalid media storage key");
  const root = path.resolve(config.mediaStoragePath);
  const target = path.resolve(root, key);
  if (target !== root && !target.startsWith(root + path.sep))
    throw internal("Invalid media storage key");
  return target;
}
export function publicMediaSignature(
  config: CoreConfig,
  asset: string,
  expires: bigint | number,
): string {
  const secret =
    trimmed(config.rawEnv.SESSION_SECRET) ??
    trimmed(config.rawEnv.AUTH_SECRET) ??
    "kasitek-dev-session-secret";
  return createHmac("sha256", secret)
    .update(`${asset}:${expires}`)
    .digest("hex");
}
export function publicMediaUrl(
  config: CoreConfig,
  asset: string,
  now = Math.floor(Date.now() / 1000),
): string {
  const expires = now + 900;
  return `${config.publicApiUrl.replace(/\/+$/, "")}/api/social/media/${encodeURIComponent(asset)}/public?expires=${expires}&signature=${publicMediaSignature(config, asset, expires)}`;
}
async function assetView(
  pool: Pool,
  org: string,
  id: string,
): Promise<ContentMediaAssetView | undefined> {
  const row = (await pool.query(SQL[0], [id, org])).rows[0];
  if (!row) return undefined;
  return {
    id: row.id,
    kind: row.kind,
    mimeType: row.mime_type,
    fileName: row.file_name,
    byteSize: wireInteger(row.byte_size),
    checksum: row.checksum,
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    processingStatus: row.processing_status,
    scanStatus: row.scan_status,
    createdAt: row.created_at,
  };
}
export async function getContentMediaAsset(
  pool: Pool,
  org: string,
  id: string,
): Promise<ContentMediaAssetView> {
  const asset = await assetView(pool, org, id);
  if (!asset) throw missing("Media asset not found");
  return asset;
}
export async function getContentMediaPreview(
  pool: Pool,
  config: CoreConfig,
  org: string,
  id: string,
): Promise<[ContentMediaAssetView, string]> {
  const asset = await getContentMediaAsset(pool, org, id);
  if (asset.processingStatus !== "READY" || asset.scanStatus !== "CLEAN")
    throw conflict("Media asset is not ready");
  const row = (await pool.query(SQL[1], [id, org])).rows[0];
  if (!row) throw missing("Media asset not found");
  const file = await stat(storagePath(config, row.storageKey)).catch(() => {
    throw missing("Media file is no longer available");
  });
  if (!file.isFile() || file.size === 0)
    throw missing("Media file is no longer available");
  return [asset, publicMediaUrl(config, id)];
}
function parseI32(bytes: Buffer, name: string): number | null {
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch {
    throw bad(`${name} must be valid text`);
  }
  if (!raw) return null;
  if (!/^[-+]?\d+$/.test(raw)) throw bad(`${name} must be a whole number`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647)
    throw bad(`${name} must be a whole number`);
  if (value < 0) throw bad(`${name} cannot be negative`);
  return value;
}
export async function uploadContentMedia(
  pool: Pool,
  config: CoreConfig,
  user: string,
  org: string,
  request: FastifyRequest,
): Promise<ContentMediaAssetView> {
  const upload: UploadFields = {
    fileName: null,
    mimeType: null,
    bytes: Buffer.alloc(0),
    width: null,
    height: null,
    durationMs: null,
  };
  try {
    for await (const part of request.parts({
      limits: { fileSize: MAX_VIDEO_BYTES, fieldSize: 1025 },
    })) {
      if (part.fieldname === "file" && part.type === "file") {
        upload.fileName = safeFileName(part.filename);
        upload.mimeType = part.mimetype.split(";")[0]!.toLowerCase();
        const chunks = [upload.bytes];
        let size = upload.bytes.length;
        for await (const chunk of part.file) {
          size += chunk.length;
          if (size > MAX_VIDEO_BYTES)
            throw bad("Videos must be 512 MB or smaller");
          chunks.push(chunk);
        }
        if (part.file.truncated) throw bad("Videos must be 512 MB or smaller");
        upload.bytes = Buffer.concat(chunks);
      } else {
        let bytes: Buffer;
        if (part.type === "file") {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of part.file) {
            size += chunk.length;
            if (size > 1024) throw bad("Media metadata is too large");
            chunks.push(chunk);
          }
          bytes = Buffer.concat(chunks);
        } else
          bytes = Buffer.isBuffer(part.value)
            ? part.value
            : Buffer.from(
                typeof part.value === "string"
                  ? part.value
                  : canonicalJson(part.value),
              );
        if (bytes.length > 1024) throw bad("Media metadata is too large");
        if (part.fieldname === "width") upload.width = parseI32(bytes, "width");
        if (part.fieldname === "height")
          upload.height = parseI32(bytes, "height");
        if (part.fieldname === "durationMs")
          upload.durationMs = parseI32(bytes, "durationMs");
      }
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw bad("Failed to read media upload");
  }
  if (!upload.bytes.length)
    throw bad("A media file is required in form-data field: file");
  return persistMedia(pool, config, user, org, upload, {
    adapter: "local",
    source: "content_upload",
  });
}
export async function uploadContentMediaBytes(
  pool: Pool,
  config: CoreConfig,
  user: string,
  org: string,
  upload: ContentMediaBytesUpload,
): Promise<ContentMediaAssetView> {
  const checksum = createHash("sha256").update(upload.bytes).digest("hex");
  const key = trimmed(upload.sourceKey);
  if (key) {
    const row = (await pool.query(SQL[2], [org, key])).rows[0];
    if (row) {
      if (
        row.mime_type !== upload.mimeType.trim().toLowerCase() ||
        BigInt(row.byte_size) !== BigInt(upload.bytes.length) ||
        row.checksum !== checksum
      )
        throw conflict(
          "Media idempotency key already belongs to different media",
        );
      if (
        await access(storagePath(config, row.storage_key)).then(
          () => true,
          () => false,
        )
      ) {
        const asset = await assetView(pool, org, row.id);
        if (asset) return asset;
      }
    }
  }
  return persistMedia(
    pool,
    config,
    user,
    org,
    {
      fileName: safeFileName(upload.fileName),
      mimeType: upload.mimeType.trim().toLowerCase(),
      bytes: upload.bytes,
      width: null,
      height: null,
      durationMs: null,
    },
    {
      adapter: "local",
      source: upload.source,
      sourceKey: upload.sourceKey ?? null,
    },
  );
}
async function persistMedia(
  pool: Pool,
  config: CoreConfig,
  user: string,
  org: string,
  upload: UploadFields,
  metadata: unknown,
): Promise<ContentMediaAssetView> {
  const mime = upload.mimeType;
  if (mime === null) throw bad("The media file must include a MIME type");
  const kind = mediaKind(mime);
  if (!kind) throw bad("Only image, video, and audio files are supported");
  if (!FORMATS[kind]!.includes(mime))
    throw bad(`Unsupported ${kind} media format`);
  if (!matchesFileSignature(mime, upload.bytes))
    throw bad("The file contents do not match the declared media format");
  const max =
    kind === "IMAGE"
      ? MAX_IMAGE_BYTES
      : kind === "VIDEO"
        ? MAX_VIDEO_BYTES
        : MAX_AUDIO_BYTES;
  if (upload.bytes.length > max)
    throw bad(`${kind} files must be ${max / 1024 / 1024} MB or smaller`);
  if (kind === "IMAGE" && upload.durationMs !== null)
    throw bad("Images cannot include a duration");
  if (kind === "VIDEO" && upload.durationMs === 0)
    throw bad("Video duration must be greater than zero");
  const id = createId(),
    checksum = createHash("sha256").update(upload.bytes).digest("hex"),
    key = `${org}/${id}.${EXTENSIONS[mime] ?? "bin"}`,
    file = storagePath(config, key);
  await mkdir(path.dirname(file), { recursive: true }).catch(() => {
    throw internal("Failed to prepare media storage");
  });
  await writeFile(file, upload.bytes).catch(() => {
    throw internal("Failed to write media storage object");
  });
  try {
    await pool.query(SQL[3], [
      id,
      org,
      user,
      kind,
      upload.fileName,
      mime,
      upload.bytes.length,
      checksum,
      upload.width,
      upload.height,
      upload.durationMs,
      key,
      canonicalJson(metadata),
    ]);
  } catch (error) {
    await unlink(file).catch(() => undefined);
    throw error;
  }
  const asset = await assetView(pool, org, id);
  if (!asset) throw internal("Uploaded media could not be reloaded");
  return asset;
}
const ready = (row: DownloadRow, read = false) => {
  if (row.processing_status !== "READY" || row.scan_status !== "CLEAN")
    throw read
      ? bad("Media asset is not ready")
      : conflict("Media asset is not ready");
};
async function download(
  config: CoreConfig,
  row: DownloadRow,
  publicRead = false,
): Promise<MediaDownload> {
  ready(row);
  const bytes = await readFile(storagePath(config, row.storage_key)).catch(
    () => {
      throw missing("Media file is no longer available");
    },
  );
  return {
    bytes,
    mimeType: row.mime_type,
    headers: {
      ...(publicRead ? { "Cache-Control": "private, max-age=900" } : {}),
      ...(row.file_name !== null
        ? {
            "Content-Disposition": `inline; filename="${row.file_name.replaceAll('"', "")}"`,
          }
        : {}),
    },
  };
}
export async function downloadContentMedia(
  pool: Pool,
  config: CoreConfig,
  org: string,
  id: string,
): Promise<MediaDownload> {
  const row = (await pool.query<DownloadRow>(SQL[4], [id, org])).rows[0];
  if (!row) throw missing("Media asset not found");
  return download(config, row);
}
export async function readContentMediaBytes(
  pool: Pool,
  config: CoreConfig,
  org: string,
  id: string,
): Promise<StoredContentMedia> {
  const row = (await pool.query<DownloadRow>(SQL[5], [id, org])).rows[0];
  if (!row) throw missing("Media asset not found");
  ready(row, true);
  const bytes = await readFile(storagePath(config, row.storage_key)).catch(
    () => {
      throw missing("Media object not found");
    },
  );
  return { bytes, mime_type: row.mime_type, checksum: row.checksum };
}
export async function deleteAudioContentMedia(
  pool: Pool,
  config: CoreConfig,
  org: string,
  id: string,
): Promise<boolean> {
  return transaction(pool, async (tx) => {
    const row = (await tx.query(SQL[6], [id, org])).rows[0];
    if (!row) return false;
    if (row.kind !== "AUDIO")
      throw bad(
        "Only audio media can be deleted by the transcription lifecycle",
      );
    if ((await tx.query(SQL[7], [id])).rows[0].exists)
      throw conflict("Audio media is still attached to published content");
    for (const key of [row.storage_key, row.preview_storage_key].filter(
      (key): key is string => key != null,
    )) {
      try {
        await unlink(storagePath(config, key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw internal(
            "The media storage object could not be removed; metadata was retained for retry",
          );
      }
    }
    await tx.query(SQL[8], [id, org]);
    return true;
  });
}
export async function downloadPublicContentMedia(
  pool: Pool,
  config: CoreConfig,
  id: string,
  expires: bigint,
  signature: string,
): Promise<MediaDownload> {
  const expected = Buffer.from(publicMediaSignature(config, id, expires));
  const given = Buffer.from(signature);
  if (
    expires < BigInt(Math.floor(Date.now() / 1000)) ||
    expected.length !== given.length ||
    !timingSafeEqual(expected, given)
  )
    throw new ApiError(401, "unauthorized", "Unauthorized");
  let row: DownloadRow | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      row = (await pool.query<DownloadRow>(SQL[9], [id])).rows[0];
      break;
    } catch (error) {
      if (attempt === 2) throw error;
      await delay(100 * (attempt + 1));
    }
  }
  if (!row) throw missing("Media asset not found");
  return download(config, row, true);
}
