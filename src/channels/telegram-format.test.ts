import { describe, it, expect } from 'vitest';
import { formatTelegramMarkdownV2 } from './telegram-format.js';

describe('formatTelegramMarkdownV2', () => {
  describe('plain text escaping', () => {
    it('escapes special MarkdownV2 characters', () => {
      expect(formatTelegramMarkdownV2('Hello. World!')).toBe(
        'Hello\\. World\\!',
      );
    });

    it('escapes all special characters', () => {
      expect(formatTelegramMarkdownV2('a-b+c=d|e{f}g(h)i[j]k~l>m#n')).toBe(
        'a\\-b\\+c\\=d\\|e\\{f\\}g\\(h\\)i\\[j\\]k\\~l\\>m\\#n',
      );
    });

    it('escapes dots and exclamation marks', () => {
      expect(formatTelegramMarkdownV2('v1.2.3 works!')).toBe(
        'v1\\.2\\.3 works\\!',
      );
    });

    it('returns empty string for empty input', () => {
      expect(formatTelegramMarkdownV2('')).toBe('');
    });

    it('handles text with only special characters', () => {
      expect(formatTelegramMarkdownV2('...')).toBe('\\.\\.\\.');
    });

    it('escapes backslashes', () => {
      expect(formatTelegramMarkdownV2('path\\to\\file')).toBe(
        'path\\\\to\\\\file',
      );
    });
  });

  describe('bold formatting', () => {
    it('preserves *bold* and escapes inner text', () => {
      expect(formatTelegramMarkdownV2('This is *bold* text')).toBe(
        'This is *bold* text',
      );
    });

    it('escapes special chars inside bold', () => {
      expect(formatTelegramMarkdownV2('*v1.0*')).toBe('*v1\\.0*');
    });

    it('handles multiple bold spans', () => {
      expect(formatTelegramMarkdownV2('*one* and *two*')).toBe(
        '*one* and *two*',
      );
    });
  });

  describe('italic formatting', () => {
    it('preserves _italic_ and escapes inner text', () => {
      expect(formatTelegramMarkdownV2('This is _italic_ text')).toBe(
        'This is _italic_ text',
      );
    });

    it('does not match underscores within words', () => {
      // snake_case should not be treated as italic
      expect(formatTelegramMarkdownV2('my_var_name')).toBe('my\\_var\\_name');
    });

    it('escapes special chars inside italic', () => {
      expect(formatTelegramMarkdownV2('_hello!_')).toBe('_hello\\!_');
    });
  });

  describe('code formatting', () => {
    it('preserves `code` spans', () => {
      expect(formatTelegramMarkdownV2('Use `npm install`')).toBe(
        'Use `npm install`',
      );
    });

    it('only escapes backticks and backslashes inside code', () => {
      // Dots and other chars should NOT be escaped inside code
      expect(formatTelegramMarkdownV2('`v1.2.3`')).toBe('`v1.2.3`');
    });

    it('escapes backslashes inside code', () => {
      expect(formatTelegramMarkdownV2('`path\\here`')).toBe('`path\\\\here`');
    });
  });

  describe('code block formatting', () => {
    it('preserves ```code blocks```', () => {
      expect(formatTelegramMarkdownV2('```console.log("hi")```')).toBe(
        '```console.log("hi")```',
      );
    });

    it('preserves multiline code blocks', () => {
      const input = '```\nline1\nline2\n```';
      const result = formatTelegramMarkdownV2(input);
      expect(result).toBe('```\nline1\nline2\n```');
    });

    it('only escapes backtick and backslash inside code blocks', () => {
      expect(formatTelegramMarkdownV2('```a.b!c```')).toBe('```a.b!c```');
    });
  });

  describe('mixed formatting', () => {
    it('handles bold and code in same message', () => {
      expect(formatTelegramMarkdownV2('Run *this* command: `npm test`')).toBe(
        'Run *this* command: `npm test`',
      );
    });

    it('handles all formatting types together', () => {
      const input = '*bold* and _italic_ and `code` here.';
      const result = formatTelegramMarkdownV2(input);
      expect(result).toBe('*bold* and _italic_ and `code` here\\.');
    });

    it('handles bullet points with formatting', () => {
      const input = '• *Task 1* - done\n• _Task 2_ - pending';
      const result = formatTelegramMarkdownV2(input);
      expect(result).toBe('• *Task 1* \\- done\n• _Task 2_ \\- pending');
    });

    it('handles numbered list with special chars', () => {
      const input = '*1.* Do something\n*2.* Do another';
      const result = formatTelegramMarkdownV2(input);
      expect(result).toBe('*1\\.* Do something\n*2\\.* Do another');
    });
  });

  describe('edge cases', () => {
    it('handles adjacent formatting', () => {
      expect(formatTelegramMarkdownV2('*bold*_italic_')).toBe('*bold*_italic_');
    });

    it('handles emoji', () => {
      expect(formatTelegramMarkdownV2('📋 Tasks')).toBe('📋 Tasks');
    });

    it('handles text with no formatting', () => {
      const input = 'Just a plain message with no formatting at all';
      expect(formatTelegramMarkdownV2(input)).toBe(input);
    });

    it('handles unclosed formatting gracefully (treated as plain text)', () => {
      // A lone * should be escaped as plain text
      expect(formatTelegramMarkdownV2('price is 5*3')).toBe('price is 5\\*3');
    });
  });
});
