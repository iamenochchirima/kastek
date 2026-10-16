type Provider = "telegram" | "whatsapp";

function escapeTelegramHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeTelegramAttribute(value: string): string {
  return escapeTelegramHtml(value).replace(/"/g, "&quot;");
}

function restoreTokens(value: string, tokens: string[]): string {
  return value.replace(/\u0000(\d+)\u0000/g, (_, index: string) => tokens[Number(index)] ?? "");
}

function formatInline(input: string, provider: Provider): string {
  const tokens: string[] = [];
  const token = (value: string): string => {
    const index = tokens.push(value) - 1;
    return `\u0000${index}\u0000`;
  };

  let value = input;
  value = value.replace(/!\[([^\]\r\n]*)\]\((https?:\/\/[^\s)]+)(?:\s+["']([^"']*)["'])?\)/g, (_, alt: string, url: string, title?: string) => token(provider === "telegram"
    ? `<a href="${escapeTelegramAttribute(url)}">🖼️ ${escapeTelegramHtml(title || alt || url)}</a>`
    : `🖼️ ${title || alt || "Image"}: ${url}`));
  value = value.replace(/`([^`\r\n]+)`/g, (_, code: string) => token(provider === "telegram" ? `<code>${escapeTelegramHtml(code)}</code>` : `\`\`\`${code}\`\`\``));
  value = value.replace(/\[([^\]\r\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label: string, url: string) => token(provider === "telegram"
    ? `<a href="${escapeTelegramAttribute(url)}">${escapeTelegramHtml(label)}</a>`
    : `${label}: ${url}`));

  if (provider === "telegram") value = escapeTelegramHtml(value);

  const protectWrapped = (pattern: RegExp, contentGroup: number, render: (content: string) => string): void => {
    value = value.replace(pattern, (...args: unknown[]) => {
      const content = args[contentGroup];
      const prefix = contentGroup > 1 && typeof args[1] === "string" ? args[1] : "";
      return `${prefix}${token(render(typeof content === "string" ? content : ""))}`;
    });
  };

  if (provider === "telegram") {
    protectWrapped(/\*\*([^*\r\n]+)\*\*/g, 1, (content) => `<b>${formatInline(content, provider)}</b>`);
    protectWrapped(/__([^_\r\n]+)__/g, 1, (content) => `<b>${formatInline(content, provider)}</b>`);
    protectWrapped(/~~([^~\r\n]+)~~/g, 1, (content) => `<s>${formatInline(content, provider)}</s>`);
    protectWrapped(/==([^=\r\n]+)==/g, 1, (content) => `<u>${formatInline(content, provider)}</u>`);
    protectWrapped(/\|\|([^|\r\n]+)\|\|/g, 1, (content) => `<tg-spoiler>${formatInline(content, provider)}</tg-spoiler>`);
    protectWrapped(/\*([^*\r\n]+)\*(?!\*)/g, 1, (content) => `<i>${formatInline(content, provider)}</i>`);
    protectWrapped(/(^|[^\w_])_([^_\r\n]+)_(?!\w)/g, 2, (content) => `<i>${formatInline(content, provider)}</i>`);
  } else {
    protectWrapped(/\*\*([^*\r\n]+)\*\*/g, 1, (content) => `*${formatInline(content, provider)}*`);
    protectWrapped(/__([^_\r\n]+)__/g, 1, (content) => `*${formatInline(content, provider)}*`);
    protectWrapped(/~~([^~\r\n]+)~~/g, 1, (content) => `~${formatInline(content, provider)}~`);
    protectWrapped(/==([^=\r\n]+)==/g, 1, (content) => formatInline(content, provider));
    protectWrapped(/\|\|([^|\r\n]+)\|\|/g, 1, (content) => formatInline(content, provider));
    protectWrapped(/\*([^*\r\n]+)\*(?!\*)/g, 1, (content) => `_${formatInline(content, provider)}_`);
    protectWrapped(/(^|[^\w_])_([^_\r\n]+)_(?!\w)/g, 2, (content) => `_${formatInline(content, provider)}_`);
  }

  return restoreTokens(value, tokens);
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, "|").trim());
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function renderTable(headers: string[], rows: string[][], provider: Provider): string[] {
  const width = Math.max(headers.length, ...rows.map((row) => row.length));
  const normalizedRows = rows.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? ""));
  const normalizedHeaders = Array.from({ length: width }, (_, index) => headers[index] ?? "");
  if (provider === "telegram") {
    const header = normalizedHeaders.map((cell) => `<b>${formatInline(cell, provider)}</b>`).join("  │  ");
    const body = normalizedRows.map((row) => row.map((cell) => formatInline(cell, provider)).join("  │  "));
    return [header, "─".repeat(Math.max(3, header.replace(/<[^>]+>/g, "").length)), ...body];
  }
  return normalizedRows.flatMap((row) => [
    row.map((cell, index) => `*${formatInline(normalizedHeaders[index]!, provider)}:* ${formatInline(cell, provider)}`).join("\n"),
    "",
  ]).slice(0, -1);
}

function formatMarkdown(input: string, provider: Provider): string {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  let fencedCode: string[] | null = null;

  const flushFence = (): void => {
    if (!fencedCode) return;
    const code = fencedCode.join("\n");
    output.push(provider === "telegram" ? `<pre>${escapeTelegramHtml(code)}</pre>` : `\`\`\`\n${code}\n\`\`\``);
    fencedCode = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      if (fencedCode) flushFence();
      else fencedCode = [];
      continue;
    }
    if (fencedCode) {
      fencedCode.push(line);
      continue;
    }

    if (index + 1 < lines.length && line.includes("|") && isTableSeparator(lines[index + 1]!)) {
      const headers = splitTableRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index]!.includes("|")) {
        rows.push(splitTableRow(lines[index]!));
        index += 1;
      }
      index -= 1;
      output.push(...renderTable(headers, rows, provider));
      continue;
    }

    const indent = line.match(/^\s*/)?.[0] ?? "";
    const content = line.slice(indent.length);
    const heading = content.match(/^#{1,6}\s+(.+?)\s*#*$/);
    if (heading) {
      const rendered = formatInline(heading[1]!, provider);
      output.push(`${indent}${provider === "telegram" ? `<b>${rendered}</b>` : `*${rendered}*`}`);
      continue;
    }
    const task = content.match(/^[-*+]\s+\[([ xX])\]\s+(.+)$/);
    if (task) {
      output.push(`${indent}${task[1]!.toLowerCase() === "x" ? "☑" : "☐"} ${formatInline(task[2]!, provider)}`);
      continue;
    }
    const unordered = content.match(/^[-+*]\s+(.+)$/);
    if (unordered) {
      output.push(`${indent}• ${formatInline(unordered[1]!, provider)}`);
      continue;
    }
    const quote = content.match(/^>\s?(.*)$/);
    if (quote) {
      output.push(`${indent}${provider === "telegram" ? `<blockquote>${formatInline(quote[1]!, provider)}</blockquote>` : `│ ${formatInline(quote[1]!, provider)}`}`);
      continue;
    }
    const ordered = content.match(/^(\d+)[.)]\s+(.+)$/);
    if (ordered) {
      output.push(`${indent}${ordered[1]}. ${formatInline(ordered[2]!, provider)}`);
      continue;
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      output.push(provider === "telegram" ? "<i>────────</i>" : "────────");
      continue;
    }
    output.push(formatInline(line, provider));
  }
  flushFence();
  return output.join("\n");
}

export function formatTelegramText(input: string): string {
  return formatMarkdown(input, "telegram");
}

export function formatWhatsAppText(input: string): string {
  return formatMarkdown(input, "whatsapp");
}
