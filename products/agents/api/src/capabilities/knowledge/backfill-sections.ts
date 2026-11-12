import type { Pool } from "pg";
import { buildSections } from "./sections";

/**
 * Derive sections for revisions ingested before section support existed.
 * Idempotent and resumable: revisions that already have sections are skipped.
 * Chunks are immutable, so this only inserts source_sections; retrieval resolves a
 * chunk's section by offset range.
 */
export async function backfillSectionsOnce(pool: Pool, limit = 25): Promise<{ revisions: number; inserted: number }> {
  const revisions = (await pool.query(
    `SELECT r.id, r.organization_id FROM agents_platform.source_revisions r
     WHERE NOT EXISTS (SELECT 1 FROM agents_platform.source_sections s WHERE s.revision_id=r.id)
     ORDER BY r.acquired_at LIMIT $1`, [limit])).rows;
  let inserted = 0;
  for (const revision of revisions) {
    const chunks = (await pool.query(
      `SELECT id,ordinal,start_offset,end_offset,content FROM agents_platform.source_chunks
       WHERE organization_id=$1 AND revision_id=$2 ORDER BY ordinal`, [revision.organization_id, revision.id])).rows;
    if (!chunks.length) continue;
    const length = chunks.reduce((max: number, chunk: any) => Math.max(max, Number(chunk.end_offset)), 0);
    const buffer = new Array<string>(length).fill(" ");
    for (const chunk of chunks) {
      const content = String(chunk.content), start = Number(chunk.start_offset);
      for (let index = 0; index < content.length; index++) buffer[start + index] = content[index]!;
    }
    const built = buildSections({ revisionId: revision.id, text: buffer.join(""),
      chunks: chunks.map((chunk: any) => ({ id: chunk.id, start: Number(chunk.start_offset), end: Number(chunk.end_offset) })) });
    for (const section of built.sections) {
      await pool.query(`INSERT INTO agents_platform.source_sections
        (id,organization_id,revision_id,ordinal,parent_ordinal,level,heading,heading_path,part,start_offset,end_offset,chars,content,content_digest)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING`,
        [section.id, revision.organization_id, revision.id, section.ordinal, section.parentOrdinal, section.level,
         section.heading, section.headingPath, section.part, section.start, section.end, section.content.length, section.content, section.digest]);
      inserted++;
    }
  }
  return { revisions: revisions.length, inserted };
}

/** Runs until no revision is left; failures are retried so a missing migration does not kill startup. */
export function startSectionBackfill(pool: Pool, log: { info: (value: unknown, message: string) => void; error: (value: unknown, message: string) => void }): { stop: () => void } {
  let stopped = false;
  const run = (async () => {
    while (!stopped) {
      try {
        const result = await backfillSectionsOnce(pool);
        if (result.revisions === 0) return;
        log.info({ event: "knowledge.sections_backfilled", ...result }, "Knowledge sections backfilled");
      } catch (error) {
        log.error({ event: "knowledge.sections_backfill_failed", error }, "Knowledge section backfill failed");
      }
      await new Promise(resolve => setTimeout(resolve, 30_000));
    }
  })();
  return { stop: () => { stopped = true; void run; } };
}
