const MAX_TELEGRAM_MESSAGE_LENGTH = 3_900;
const TEXT_SPECIALS = new Set(["_", "*", "[", "]", "(", ")", "~", "`", ">", "#", "+", "-", "=", "|", "{", "}", ".", "!", "\\"]);

export function toTelegramMarkdownV2(markdown: string, maximumLength = MAX_TELEGRAM_MESSAGE_LENGTH): string {
  const normalized = markdown.replace(/\r\n?/g, "\n").trim();
  const pieces: Array<{ kind: "text" | "code"; value: string }> = [];
  const fence = /```[^\n]*\n([\s\S]*?)```/g;
  let cursor = 0;
  for (const match of normalized.matchAll(fence)) {
    const index = match.index ?? 0;
    if (index > cursor) pieces.push({ kind: "text", value: normalized.slice(cursor, index) });
    pieces.push({ kind: "code", value: match[1] });
    cursor = index + match[0].length;
  }
  if (cursor < normalized.length) pieces.push({ kind: "text", value: normalized.slice(cursor) });
  if (pieces.length === 0) pieces.push({ kind: "text", value: normalized });

  const rendered = pieces.map((piece) => piece.kind === "code"
    ? `\`\`\`\n${escapeCode(piece.value.replace(/\n$/, ""))}\n\`\`\``
    : renderText(piece.value)).join("");
  if (rendered.length <= maximumLength) return rendered;
  return escapeLiteral(markdown, maximumLength);
}

function renderText(value: string): string {
  return value.split("\n").map((originalLine) => {
    let line = originalLine;
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (heading) return `*${escapeText(heading[1])}*`;

    const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (quote) line = `│ ${quote[1]}`;

    const unordered = /^\s*[-+*]\s+(.*)$/.exec(line);
    if (unordered) line = `• ${unordered[1]}`;

    const ordered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (ordered) return `${ordered[1]}\\. ${renderInline(ordered[2])}`;
    return renderInline(line);
  }).join("\n");
}

function renderInline(value: string): string {
  const syntax = /\[([^\]\n]+)\]\(([^)\n]*)\)|\*\*([\s\S]+?)\*\*|~~([\s\S]+?)~~|`([^`\n]+)`|\*([^*\n]+)\*/g;
  let output = "";
  let cursor = 0;
  for (const match of value.matchAll(syntax)) {
    const index = match.index ?? 0;
    output += escapeText(value.slice(cursor, index));
    if (match[1] !== undefined) {
      output += `${escapeText(match[1])} (${escapeText(match[2])})`;
    } else if (match[3] !== undefined) {
      output += `*${escapeText(match[3])}*`;
    } else if (match[4] !== undefined) {
      output += `~${escapeText(match[4])}~`;
    } else if (match[5] !== undefined) {
      output += `\`${escapeCode(match[5])}\``;
    } else if (match[6] !== undefined) {
      output += `_${escapeText(match[6])}_`;
    }
    cursor = index + match[0].length;
  }
  return output + escapeText(value.slice(cursor));
}

function escapeText(value: string): string {
  let output = "";
  for (const character of value) output += TEXT_SPECIALS.has(character) ? `\\${character}` : character;
  return output;
}

function escapeCode(value: string): string {
  return value.replace(/[\\`]/g, "\\$&");
}

function escapeLiteral(value: string, maximumLength: number): string {
  const fullSuffix = escapeText("… [report truncated]");
  const suffix = maximumLength >= fullSuffix.length ? fullSuffix : maximumLength > 0 ? "…" : "";
  const limit = Math.max(0, maximumLength - suffix.length);
  let output = "";
  let truncated = false;
  for (const character of value) {
    const escaped = TEXT_SPECIALS.has(character) ? `\\${character}` : character;
    if (output.length + escaped.length > limit) {
      truncated = true;
      break;
    }
    output += escaped;
  }
  if (truncated) output += suffix;
  return output;
}
