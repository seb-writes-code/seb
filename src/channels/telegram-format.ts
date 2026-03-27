/**
 * Converts "Telegram-safe markdown" (as used in CLAUDE.md agent instructions)
 * to Telegram MarkdownV2 format by escaping special characters outside of
 * formatting spans.
 *
 * Input format (from agents):
 *   *bold*  _italic_  `code`  ```code blocks```  • bullets
 *
 * MarkdownV2 requires escaping these outside formatting spans:
 *   _ * [ ] ( ) ~ ` > # + - = | { } . !
 *
 * Inside `code` and ```pre``` blocks only ` and \ need escaping.
 */

/** Characters that must be escaped in normal MarkdownV2 text */
const ESCAPE_CHARS = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

/** Characters that must be escaped inside code/pre blocks */
const CODE_ESCAPE_CHARS = /([`\\])/g;

interface Span {
  type: 'text' | 'bold' | 'italic' | 'code' | 'codeblock';
  content: string;
}

/**
 * Parse agent output into spans of formatted and unformatted text.
 * Handles code blocks first (```...```), then inline code (`...`),
 * then bold (*...*) and italic (_..._).
 */
function parseSpans(text: string): Span[] {
  const spans: Span[] = [];
  let remaining = text;

  // First pass: extract code blocks and inline code (they take priority)
  const codeBlockRegex = /```([\s\S]*?)```/;
  const inlineCodeRegex = /`([^`\n]+)`/;
  const boldRegex = /\*([^*\n]+)\*/;
  const italicRegex = /(?<![a-zA-Z0-9])_([^_\n]+)_(?![a-zA-Z0-9])/;

  while (remaining.length > 0) {
    // Find the earliest match among all formatting types
    const codeBlockMatch = codeBlockRegex.exec(remaining);
    const inlineCodeMatch = inlineCodeRegex.exec(remaining);
    const boldMatch = boldRegex.exec(remaining);
    const italicMatch = italicRegex.exec(remaining);

    type MatchInfo = {
      type: Span['type'];
      match: RegExpExecArray;
      content: string;
    };
    const candidates: MatchInfo[] = [];
    if (codeBlockMatch)
      candidates.push({
        type: 'codeblock',
        match: codeBlockMatch,
        content: codeBlockMatch[1],
      });
    if (inlineCodeMatch)
      candidates.push({
        type: 'code',
        match: inlineCodeMatch,
        content: inlineCodeMatch[1],
      });
    if (boldMatch)
      candidates.push({
        type: 'bold',
        match: boldMatch,
        content: boldMatch[1],
      });
    if (italicMatch)
      candidates.push({
        type: 'italic',
        match: italicMatch,
        content: italicMatch[1],
      });

    if (candidates.length === 0) {
      // No more formatting found — rest is plain text
      spans.push({ type: 'text', content: remaining });
      break;
    }

    // Pick the earliest match (leftmost)
    candidates.sort((a, b) => a.match.index - b.match.index);
    const winner = candidates[0];

    // Add text before the match
    if (winner.match.index > 0) {
      spans.push({
        type: 'text',
        content: remaining.slice(0, winner.match.index),
      });
    }

    spans.push({ type: winner.type, content: winner.content });
    remaining = remaining.slice(winner.match.index + winner.match[0].length);
  }

  return spans;
}

/** Escape text for MarkdownV2 normal context */
function escapeMarkdownV2(text: string): string {
  return text.replace(ESCAPE_CHARS, '\\$1');
}

/** Escape text inside code/pre blocks */
function escapeCodeContent(text: string): string {
  return text.replace(CODE_ESCAPE_CHARS, '\\$1');
}

/**
 * Convert agent markdown to Telegram MarkdownV2 format.
 *
 * Handles: *bold*, _italic_, `code`, ```code blocks```, and plain text escaping.
 * Returns the formatted string ready for Telegram's MarkdownV2 parse mode.
 */
export function formatTelegramMarkdownV2(text: string): string {
  const spans = parseSpans(text);
  return spans
    .map((span) => {
      switch (span.type) {
        case 'bold':
          return `*${escapeMarkdownV2(span.content)}*`;
        case 'italic':
          return `_${escapeMarkdownV2(span.content)}_`;
        case 'code':
          return `\`${escapeCodeContent(span.content)}\``;
        case 'codeblock':
          return `\`\`\`${escapeCodeContent(span.content)}\`\`\``;
        case 'text':
          return escapeMarkdownV2(span.content);
      }
    })
    .join('');
}
