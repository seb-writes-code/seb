import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, createTask, getTaskById } from './db.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  startSchedulerLoop,
} from './task-scheduler.js';

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('computeNextRun falls back to 60s for invalid interval values', () => {
    const baseTask = {
      id: 'invalid-interval',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      context_mode: 'isolated' as const,
      next_run: new Date().toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const now = Date.now();

    // Zero interval would cause infinite while-loop without the guard
    const zeroResult = computeNextRun({ ...baseTask, schedule_value: '0' });
    expect(zeroResult).not.toBeNull();
    expect(new Date(zeroResult!).getTime()).toBeGreaterThanOrEqual(
      now + 60_000,
    );

    // Negative interval
    const negResult = computeNextRun({ ...baseTask, schedule_value: '-5000' });
    expect(negResult).not.toBeNull();
    expect(new Date(negResult!).getTime()).toBeGreaterThanOrEqual(now + 60_000);

    // Non-numeric string
    const nanResult = computeNextRun({ ...baseTask, schedule_value: 'abc' });
    expect(nanResult).not.toBeNull();
    expect(new Date(nanResult!).getTime()).toBeGreaterThanOrEqual(now + 60_000);
  });

  it('computeNextRun returns null for invalid cron expressions instead of throwing', () => {
    const task = {
      id: 'bad-cron',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'cron' as const,
      schedule_value: 'not a valid cron',
      context_mode: 'isolated' as const,
      next_run: new Date().toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    // Should return null instead of throwing, preventing tasks from
    // getting stuck in 'running' status when cron parsing fails
    expect(computeNextRun(task)).toBeNull();
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });

  it('computeNextRun uses task.timezone for cron tasks (DST boundary)', () => {
    // March 8, 2026 is when DST spring-forward happens in America/Los_Angeles
    // (2:00 AM -> 3:00 AM). A "0 9 * * *" cron in LA should fire at 9am PT,
    // which is 17:00 UTC during PST and 16:00 UTC during PDT.
    const task = {
      id: 'tz-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'cron' as const,
      schedule_value: '0 9 * * *', // 9am daily
      context_mode: 'isolated' as const,
      next_run: null,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
      timezone: 'America/Los_Angeles',
    };

    // Set time to March 9, 2026 at 00:00 UTC (after spring-forward)
    vi.setSystemTime(new Date('2026-03-09T00:00:00.000Z'));
    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // 9am PDT = UTC-7 = 16:00 UTC (after spring-forward)
    const nextDate = new Date(nextRun!);
    expect(nextDate.getUTCHours()).toBe(16);
    expect(nextDate.getUTCMinutes()).toBe(0);

    // Now check before spring-forward: March 7, 2026 (still PST)
    vi.setSystemTime(new Date('2026-03-07T00:00:00.000Z'));
    const nextRunPST = computeNextRun(task);
    expect(nextRunPST).not.toBeNull();

    // 9am PST = UTC-8 = 17:00 UTC (before spring-forward)
    const nextDatePST = new Date(nextRunPST!);
    expect(nextDatePST.getUTCHours()).toBe(17);
    expect(nextDatePST.getUTCMinutes()).toBe(0);
  });

  it('computeNextRun falls back to global TIMEZONE when task has no timezone', () => {
    const task = {
      id: 'no-tz-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'cron' as const,
      schedule_value: '0 9 * * *',
      context_mode: 'isolated' as const,
      next_run: null,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
      // no timezone field — should fall back to global TIMEZONE
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Just verify it returns a valid date — the exact hour depends on the test env's TIMEZONE
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
  });

  it('computeNextRun falls back to now + interval when next_run is null', () => {
    const ms = 60000;
    const task = {
      id: 'null-next-run',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: null,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const before = Date.now();
    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    const nextMs = new Date(nextRun!).getTime();
    // Should be approximately now + interval
    expect(nextMs).toBeGreaterThanOrEqual(before + ms);
    expect(nextMs).toBeLessThanOrEqual(Date.now() + ms + 1000);
  });
});
