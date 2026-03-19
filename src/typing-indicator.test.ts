import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TypingIndicatorManager } from './typing-indicator.js';

describe('TypingIndicatorManager', () => {
  let manager: TypingIndicatorManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new TypingIndicatorManager();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls sendTyping immediately on start', async () => {
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    await manager.start('chat1', sendTyping);
    expect(sendTyping).toHaveBeenCalledTimes(1);
    manager.stop('chat1');
  });

  it('refreshes typing every 4 seconds', async () => {
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    await manager.start('chat1', sendTyping);
    expect(sendTyping).toHaveBeenCalledTimes(1);

    // Advance past the 3s minimum gap + 4s interval
    await vi.advanceTimersByTimeAsync(4000);
    expect(sendTyping).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(4000);
    expect(sendTyping).toHaveBeenCalledTimes(3);

    manager.stop('chat1');
  });

  it('stops refreshing when stop is called', async () => {
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    await manager.start('chat1', sendTyping);
    manager.stop('chat1');

    await vi.advanceTimersByTimeAsync(8000);
    expect(sendTyping).toHaveBeenCalledTimes(1);
  });

  it('enforces minimum 3s gap between sends', async () => {
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    await manager.start('chat1', sendTyping);
    expect(sendTyping).toHaveBeenCalledTimes(1);

    // At 2s the interval hasn't fired yet (4s interval), but if we
    // manually tried to send, the 3s gap would block it
    manager.stop('chat1');
  });

  it('stops on 429 rate limit error', async () => {
    let callCount = 0;
    const sendTyping = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 2) {
        const err: any = new Error('Too Many Requests');
        err.error_code = 429;
        throw err;
      }
    });

    await manager.start('chat1', sendTyping);
    expect(sendTyping).toHaveBeenCalledTimes(1);

    // Trigger the interval — should get 429 and stop
    await vi.advanceTimersByTimeAsync(4000);
    expect(sendTyping).toHaveBeenCalledTimes(2);

    // Should not fire again after 429
    await vi.advanceTimersByTimeAsync(4000);
    expect(sendTyping).toHaveBeenCalledTimes(2);
  });

  it('handles 429 with response.error_code format', async () => {
    let callCount = 0;
    const sendTyping = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 2) {
        const err: any = new Error('Too Many Requests');
        err.response = { error_code: 429 };
        throw err;
      }
    });

    await manager.start('chat1', sendTyping);
    await vi.advanceTimersByTimeAsync(4000);

    // Should stop after 429
    await vi.advanceTimersByTimeAsync(4000);
    expect(sendTyping).toHaveBeenCalledTimes(2);
  });

  it('swallows non-429 errors without stopping', async () => {
    let callCount = 0;
    const sendTyping = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 2) {
        throw new Error('Network glitch');
      }
    });

    await manager.start('chat1', sendTyping);
    await vi.advanceTimersByTimeAsync(4000);
    expect(sendTyping).toHaveBeenCalledTimes(2);

    // Should continue after non-429 error
    await vi.advanceTimersByTimeAsync(4000);
    expect(sendTyping).toHaveBeenCalledTimes(3);

    manager.stop('chat1');
  });

  it('clears previous interval when start is called again', async () => {
    const sendTyping1 = vi.fn().mockResolvedValue(undefined);
    const sendTyping2 = vi.fn().mockResolvedValue(undefined);

    await manager.start('chat1', sendTyping1);
    // Wait past the 3s minimum gap before calling start again
    await vi.advanceTimersByTimeAsync(3000);
    await manager.start('chat1', sendTyping2);

    await vi.advanceTimersByTimeAsync(4000);
    // First callback shouldn't fire again after being replaced
    expect(sendTyping1).toHaveBeenCalledTimes(1);
    expect(sendTyping2).toHaveBeenCalledTimes(2); // initial + 1 interval
    manager.stop('chat1');
  });

  it('tracks separate chats independently', async () => {
    const send1 = vi.fn().mockResolvedValue(undefined);
    const send2 = vi.fn().mockResolvedValue(undefined);

    await manager.start('chat1', send1);
    await manager.start('chat2', send2);

    manager.stop('chat1');
    await vi.advanceTimersByTimeAsync(4000);

    expect(send1).toHaveBeenCalledTimes(1); // stopped
    expect(send2).toHaveBeenCalledTimes(2); // still going
    manager.stop('chat2');
  });

  it('stop is safe to call on unknown chat', () => {
    expect(() => manager.stop('nonexistent')).not.toThrow();
  });
});
