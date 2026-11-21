import { createHash } from "node:crypto";

/**
 * Sections are the retrieval unit. Chunks stay small so matching is precise, but every
 * chunk belongs to a heading-bounded section, and a section is what a search returns.
 * A section over the result budget is split into parts on line boundaries, never on
 * characters, so a table row is never cut in half.
 */
export const SECTION_LIMITS = Object.freeze({ partBytes: 8192, maxSections: 4096, maxParts: 64 });

export interface SectionPart {
  id: string;
  ordinal: number;
  parentOrdinal: number | null;
  level: number;
  heading: string;
  headingPath: string;
  part: number;
  start: number;
  end: number;
  content: string;
  digest: string;
}
export interface ChunkSection { chunkId: string; sectionId: string; sectionOrdinal: number; sectionPart: number }
export interface BuiltSections { sections: SectionPart[]; chunks: ChunkSection[] }

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export function stableSectionId(revisionId: string, ordinal: number, part: number): string {
  const hash = createHash("sha256").update(`${revisionId}:${ordinal}:${part}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

interface HeadingMark { start: number; level: number; title: string }

function headingMarks(text: string): HeadingMark[] {
  const marks: HeadingMark[] = [];
  for (const match of text.matchAll(/^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*$/gm)) {
    marks.push({ start: match.index ?? 0, level: match[1]!.length, title: match[2]!.trim() });
  }
  return marks;
}

/** Split on line boundaries; a single overlong line is the only case cut inside a line. */
function splitParts(offset: number, content: string): Array<{ start: number; end: number }> {
  const parts: Array<{ start: number; end: number }> = [];
  let start = 0;
  while (start < content.length && parts.length < SECTION_LIMITS.maxParts) {
    let end = Math.min(content.length, start + SECTION_LIMITS.partBytes);
    if (end < content.length) {
      const newline = content.lastIndexOf("\n", end);
      if (newline > start + Math.floor(SECTION_LIMITS.partBytes / 2)) end = newline + 1;
    }
    parts.push({ start: offset + start, end: offset + end });
    start = end;
  }
  return parts.length ? parts : [{ start: offset, end: offset + content.length }];
}

interface LogicalSection { start: number; end: number; level: number; heading: string; headingPath: string; parentOrdinal: number | null }

function logicalSections(text: string): LogicalSection[] {
  const marks = headingMarks(text);
  if (!marks.length) return [{ start: 0, end: text.length, level: 0, heading: "Document", headingPath: "Document", parentOrdinal: null }];
  const spans: LogicalSection[] = marks.map((mark, index) => {
    let end = text.length;
    for (const next of marks.slice(index + 1)) {
      if (next.level <= mark.level) { end = next.start; break; }
    }
    return { start: mark.start, end, level: mark.level, heading: mark.title, headingPath: mark.title, parentOrdinal: null };
  });
  if (spans.length > SECTION_LIMITS.maxSections) {
    return [{ start: 0, end: text.length, level: 0, heading: "Document", headingPath: "Document", parentOrdinal: null }];
  }
  for (let index = 0; index < spans.length; index++) {
    let parent: number | null = null;
    for (let candidate = index - 1; candidate >= 0; candidate--) {
      if (spans[candidate]!.level < spans[index]!.level) { parent = candidate; break; }
    }
    spans[index]!.parentOrdinal = parent;
    const lineage: string[] = [];
    let cursor: number | null = index;
    while (cursor !== null) { lineage.unshift(spans[cursor]!.heading); cursor = spans[cursor]!.parentOrdinal; }
    spans[index]!.headingPath = lineage.join(" / ");
  }
  return spans;
}

export function buildSections(input: {
  revisionId: string;
  text: string;
  chunks: ReadonlyArray<{ id: string; start: number; end: number }>;
}): BuiltSections {
  const { revisionId, text, chunks } = input;
  const logical = logicalSections(text);
  const sections: SectionPart[] = [];
  const spans: Array<{ ordinal: number; start: number; end: number; parts: Array<{ part: number; start: number; end: number }> }> = [];
  for (const [ordinal, section] of logical.entries()) {
    const content = text.slice(section.start, section.end);
    const parts = splitParts(section.start, content);
    spans.push({ ordinal, start: section.start, end: section.end, parts: parts.map((range, index) => ({ part: index + 1, ...range })) });
    for (const [index, range] of parts.entries()) {
      const partContent = text.slice(range.start, range.end);
      sections.push({
        id: stableSectionId(revisionId, ordinal, index + 1),
        ordinal, parentOrdinal: section.parentOrdinal, level: section.level,
        heading: section.heading, headingPath: section.headingPath, part: index + 1,
        start: range.start, end: range.end, content: partContent, digest: digest(partContent),
      });
    }
  }
  const mapped: ChunkSection[] = [];
  for (const chunk of chunks) {
    let target = spans[0]!;
    let best = { level: -1, start: -1 };
    for (const span of spans) {
      const logicalSpan = logical[span.ordinal]!;
      if (chunk.start >= span.start && chunk.start < span.end &&
        (logicalSpan.level > best.level || logicalSpan.level === best.level && span.start > best.start)) {
        target = span; best = { level: logicalSpan.level, start: span.start };
      }
    }
    const part = target.parts.find(range => chunk.start >= range.start && chunk.start < range.end) ?? target.parts[0]!;
    mapped.push({ chunkId: chunk.id, sectionId: stableSectionId(revisionId, target.ordinal, part.part), sectionOrdinal: target.ordinal, sectionPart: part.part });
  }
  return { sections, chunks: mapped };
}

/** Embedded text carries its section, so a row chunk still says what it belongs to. */
export function embeddingText(headingPath: string, chunkText: string): string {
  return `${headingPath}\n${chunkText}`;
}
