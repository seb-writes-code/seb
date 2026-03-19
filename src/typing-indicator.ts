import { logger } from './logger.js';

/**
 * Rate-limit-safe typing indicator that refreshes every 4s
 * with a minimum 3s gap between sends per chat.
 */
export class TypingIndicatorManager {
  private intervals = new Map<string, ReturnType<typeof setInterval>>();
  private lastSent = new Map<string, number>();

  async start(
    chatId: string,
    sendTyping: () => Promise<void>,
  ): Promise<void> {
    this.stop(chatId);
    await this.sendSafe(chatId, sendTyping);
    const interval = setInterval(() => this.sendSafe(chatId, sendTyping), 4000);
    this.intervals.set(chatId, interval);
  }

  private async sendSafe(
    chatId: string,
    sendTyping: () => Promise<void>,
  ): Promise<void> {
    const now = Date.now();
    if (now - (this.lastSent.get(chatId) ?? 0) < 3000) return;
    try {
      await sendTyping();
      this.lastSent.set(chatId, Date.now());
    } catch (err: any) {
      const code = err?.error_code ?? err?.response?.error_code;
      if (code === 429) {
        logger.warn({ chatId }, 'Typing indicator rate limited, stopping');
        this.stop(chatId);
        return;
      }
      logger.debug({ chatId, err }, 'Typing indicator send failed');
    }
  }

  stop(chatId: string): void {
    const t = this.intervals.get(chatId);
    if (t) {
      clearInterval(t);
      this.intervals.delete(chatId);
    }
  }
}
