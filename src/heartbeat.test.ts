import { describe, it, expect } from 'vitest';

import {
  formatElapsed,
  buildStatusResponse,
  _getCurrentTasks,
} from './index.js';

describe('formatElapsed', () => {
  it('formats seconds only', () => {
    expect(formatElapsed(5000)).toBe('5s');
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(59000)).toBe('59s');
  });

  it('formats minutes and seconds', () => {
    expect(formatElapsed(60000)).toBe('1m 0s');
    expect(formatElapsed(90000)).toBe('1m 30s');
    expect(formatElapsed(125000)).toBe('2m 5s');
  });

  it('formats large durations', () => {
    expect(formatElapsed(600000)).toBe('10m 0s');
    expect(formatElapsed(3661000)).toBe('61m 1s');
  });
});

describe('buildStatusResponse', () => {
  it('returns idle message when no task is running', () => {
    const tasks = _getCurrentTasks();
    tasks.clear();

    const response = buildStatusResponse('test-jid');
    expect(response).toContain('idle');
  });

  it('returns task info when a task is running', () => {
    const tasks = _getCurrentTasks();
    tasks.set('test-jid', {
      groupName: 'Test Group',
      startedAt: Date.now() - 120000, // 2 minutes ago
      lastMessageAt: Date.now() - 30000, // 30 seconds ago
    });

    const response = buildStatusResponse('test-jid');
    expect(response).toContain('Test Group');
    expect(response).toContain('2m');
    expect(response).toContain('30s');

    tasks.clear();
  });

  it('only shows status for the queried chat JID', () => {
    const tasks = _getCurrentTasks();
    tasks.set('other-jid', {
      groupName: 'Other Group',
      startedAt: Date.now() - 60000,
      lastMessageAt: Date.now(),
    });

    const response = buildStatusResponse('test-jid');
    expect(response).toContain('idle');

    tasks.clear();
  });
});
