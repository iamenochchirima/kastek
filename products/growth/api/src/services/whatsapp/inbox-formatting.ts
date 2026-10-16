import { bad } from "./common.js";

/** Render the existing Agent Markdown output for WhatsApp's text conventions. */
export function formatWhatsappText(input: string): string {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  let code: string[] | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.trim().startsWith("```")) {
      if (code) {
        output.push(`\`\`\`\n${code.join("\n")}\n\`\`\``);
        code = null;
      } else code = [];
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    if (
      index + 1 < lines.length &&
      line.includes("|") &&
      tableSeparator(lines[index + 1]!)
    ) {
      const headers = splitTableRow(line),
        rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index]!.includes("|"))
        rows.push(splitTableRow(lines[index++]!));
      index--;
      const width = Math.max(headers.length, ...rows.map((row) => row.length));
      rows.forEach((row, rowIndex) => {
        output.push(
          Array.from(
            { length: width },
            (_, column) =>
              `*${formatInline(headers[column] ?? "")}:* ${formatInline(row[column] ?? "")}`,
          ).join("\n"),
        );
        if (rowIndex + 1 < rows.length) output.push("");
      });
      continue;
    }
    const indent = line.match(/^\s*/u)![0],
      content = line.slice(indent.length);
    const heading = content.match(/^(#{1,6}) (.*)$/u);
    const task = content.match(/^- \[([ xX])\] (.*)$/u);
    const unordered = content.match(/^[-+*] (.*)$/u);
    const ordered = content.match(/^(\d+)[.)] (.*)$/u);
    if (heading)
      output.push(
        `${indent}*${formatInline(heading[2]!.trim().replace(/#+$/u, "").trim())}*`,
      );
    else if (task)
      output.push(
        `${indent}${task[1] === " " ? "☐" : "☑"} ${formatInline(task[2]!)}`,
      );
    else if (unordered)
      output.push(`${indent}• ${formatInline(unordered[1]!)}`);
    else if (content.startsWith(">"))
      output.push(`${indent}│ ${formatInline(content.slice(1).trimStart())}`);
    else if (ordered)
      output.push(`${indent}${ordered[1]}. ${formatInline(ordered[2]!)}`);
    else if (horizontalRule(line)) output.push("────────");
    else output.push(formatInline(line));
  }
  if (code) output.push(`\`\`\`\n${code.join("\n")}\n\`\`\``);
  return output.join("\n");
}

export function extractMarkdownImages(input: string): {
  text: string;
  images: string[];
} {
  const images: string[] = [];
  let text = input
    .replace(
      /!\[([^\]\r\n]*)\]\((https?:\/\/[^\s)]+)(?:\s+["']([^"']*)["'])?\)/gu,
      (_full, _label: string, url: string) => {
        if (Buffer.byteLength(url) <= 2048) images.push(url);
        return "";
      },
    )
    .trim();
  while (text.includes("\n\n\n")) text = text.replaceAll("\n\n\n", "\n\n");
  return { text, images };
}

function wrapped(
  input: string,
  delimiter: string,
): { consumed: number; content: string } | null {
  if (!input.startsWith(delimiter)) return null;
  const end = input.indexOf(delimiter, delimiter.length);
  if (end < 0) return null;
  const content = input.slice(delimiter.length, end);
  return !content || /^\s|\s$/u.test(content)
    ? null
    : { consumed: end + delimiter.length, content };
}

function link(
  input: string,
  image: boolean,
): { consumed: number; label: string; url: string } | null {
  const prefix = image ? "![" : "[";
  if (!input.startsWith(prefix)) return null;
  const labelEnd = input.indexOf("](", prefix.length);
  if (labelEnd < 0) return null;
  const targetEnd = input.indexOf(")", labelEnd + 2);
  if (targetEnd < 0) return null;
  const url = input
    .slice(labelEnd + 2, targetEnd)
    .trim()
    .split(/\s+/u)[0]!
    .replace(/^<+|>+$/gu, "");
  return /^https?:\/\//u.test(url)
    ? {
        consumed: targetEnd + 1,
        label: input.slice(prefix.length, labelEnd),
        url,
      }
    : null;
}

function formatInline(input: string): string {
  let output = "",
    index = 0;
  while (index < input.length) {
    const remaining = input.slice(index);
    const image = link(remaining, true),
      reference = image ?? link(remaining, false);
    if (reference) {
      output += `${image ? "🖼️ " : ""}${formatInline(image && !reference.label ? "Image" : reference.label)}: ${reference.url}`;
      index += reference.consumed;
      continue;
    }
    let found = false;
    for (const [delimiter, replacement] of [
      ["`", "```"],
      ["**", "*"],
      ["__", "*"],
      ["~~", "~"],
      ["==", ""],
      ["||", ""],
      ["*", "_"],
    ] as const) {
      const value = wrapped(remaining, delimiter);
      if (!value) continue;
      output += `${replacement}${delimiter === "`" ? value.content : formatInline(value.content)}${replacement}`;
      index += value.consumed;
      found = true;
      break;
    }
    if (found) continue;
    if (
      remaining.startsWith("_") &&
      !remaining.startsWith("__") &&
      !/[\p{L}\p{N}]$/u.test(input.slice(0, index))
    ) {
      const value = wrapped(remaining, "_");
      if (value && !/^[\p{L}\p{N}]/u.test(remaining.slice(value.consumed))) {
        output += `_${formatInline(value.content)}_`;
        index += value.consumed;
        continue;
      }
    }
    const character = String.fromCodePoint(input.codePointAt(index)!);
    output += character;
    index += character.length;
  }
  return output;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|+|\|+$/gu, "");
  const cells: string[] = [];
  let current = "",
    escaped = false;
  for (const character of trimmed) {
    if (character === "|" && !escaped) {
      cells.push(current.trim().replaceAll("\\|", "|"));
      current = "";
    } else {
      escaped = character === "\\" && !escaped;
      current += character;
      if (character !== "\\") escaped = false;
    }
  }
  cells.push(current.trim().replaceAll("\\|", "|"));
  return cells;
}
function tableSeparator(line: string): boolean {
  return splitTableRow(line).every((cell) =>
    /^-{3,}$/u.test(cell.replace(/^:+|:+$/gu, "")),
  );
}
function horizontalRule(line: string): boolean {
  const trimmed = line.trim(),
    first = trimmed[0];
  return (
    !!first &&
    "-_*".includes(first) &&
    [...trimmed].every(
      (character) => character === first || /\s/u.test(character),
    ) &&
    [...trimmed].filter((character) => character === first).length >= 3
  );
}
export function validateAgentDeliveryIdempotencyKey(input: string): string {
  const value = input.trim();
  if (!value || Buffer.byteLength(value) > 240)
    throw bad("A valid agent delivery idempotency key is required");
  return value;
}
export function isProviderAuthenticationFailure(error: string): boolean {
  const normalized = error.replace(/[A-Z]/g, (character) =>
    character.toLowerCase(),
  );
  return [
    "401 unauthorized",
    "403 forbidden",
    "authentication error",
    "invalid oauth access token",
  ].some((value) => normalized.includes(value));
}
export function whatsappDeletedMessageResponderType(
  sender: string,
  metadata?: Record<string, unknown> | null,
): "customer" | "agent" | "system" | "human" {
  if (sender === "customer") return "customer";
  if (
    typeof metadata?._kasitek_agent_idempotency_key === "string" &&
    metadata._kasitek_agent_idempotency_key.length
  )
    return "agent";
  return metadata?._kasitek_inbox_message_kind === "template"
    ? "system"
    : "human";
}
