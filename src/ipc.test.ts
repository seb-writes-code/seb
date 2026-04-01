import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock db
vi.mock('./db.js', () => ({
  createTask: vi.fn(),
  deleteTask: vi.fn(),
  getTaskById: vi.fn(),
  updateTask: vi.fn(),
}));

// Mock group-folder
vi.mock('./group-folder.js', () => ({
  isValidGroupFolder: vi.fn(() => true),
}));

// Mock config
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/test-data',
  IPC_POLL_INTERVAL: 1000,
  TELEGRAM_BOT_POOL: [],
  TIMEZONE: 'UTC',
}));

// Mock channels/telegram
vi.mock('./channels/telegram.js', () => ({
  sendPoolMessage: vi.fn(),
}));

import { processTaskIpc, checkDispatchRateLimit, IpcDeps } from './ipc.js';
import { logger } from './logger.js';

function createMockDeps(): IpcDeps {
  return {
    sendMessage: vi.fn(),
    ack: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'linear:CHR-87': {
        name: 'CHR-87',
        folder: 'linear_chr-87',
        trigger: '@Seb',
        added_at: '2026-01-01T00:00:00.000Z',
      },
      'tg:-1001234567890': {
        name: 'Main',
        folder: 'main',
        trigger: '@Seb',
        added_at: '2026-01-01T00:00:00.000Z',
        isMain: true,
      },
    })),
    registerGroup: vi.fn(),
    syncGroups: vi.fn(),
    getAvailableGroups: vi.fn(() => []),
    writeGroupsSnapshot: vi.fn(),
    onTasksChanged: vi.fn(),
    dispatchContainer: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('dispatch_container IPC handler', () => {
  it('dispatches container for a registered group', async () => {
    const deps = createMockDeps();

    await processTaskIpc(
      {
        type: 'dispatch_container',
        groupJid: 'linear:CHR-87',
        message: 'Do the research',
        sender: 'system',
      },
      'main',
      true,
      deps,
    );

    expect(deps.dispatchContainer).toHaveBeenCalledWith(
      'linear:CHR-87',
      'Do the research',
      'system',
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        groupJid: 'linear:CHR-87',
        sourceGroup: 'main',
        sender: 'system',
      }),
      'Container dispatched via IPC',
    );
  });

  it('defaults sender to "system" when not provided', async () => {
    const deps = createMockDeps();

    await processTaskIpc(
      {
        type: 'dispatch_container',
        groupJid: 'linear:CHR-87',
        message: 'Do the work',
      },
      'main',
      true,
      deps,
    );

    expect(deps.dispatchContainer).toHaveBeenCalledWith(
      'linear:CHR-87',
      'Do the work',
      'system',
    );
  });

  it('rejects dispatch for unregistered group JID', async () => {
    const deps = createMockDeps();

    await processTaskIpc(
      {
        type: 'dispatch_container',
        groupJid: 'linear:UNKNOWN-999',
        message: 'Do something',
      },
      'main',
      true,
      deps,
    );

    expect(deps.dispatchContainer).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        groupJid: 'linear:UNKNOWN-999',
      }),
      'dispatch_container: target group not registered',
    );
  });

  it('blocks non-main group from dispatching to other groups', async () => {
    const deps = createMockDeps();

    await processTaskIpc(
      {
        type: 'dispatch_container',
        groupJid: 'linear:CHR-87',
        message: 'Try to dispatch',
      },
      'some-other-group',
      false,
      deps,
    );

    expect(deps.dispatchContainer).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceGroup: 'some-other-group',
      }),
      'Unauthorized dispatch_container attempt blocked',
    );
  });

  it('warns on missing required fields', async () => {
    const deps = createMockDeps();

    await processTaskIpc(
      {
        type: 'dispatch_container',
        groupJid: 'linear:CHR-87',
        // missing message
      },
      'main',
      true,
      deps,
    );

    expect(deps.dispatchContainer).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.any(Object) }),
      'dispatch_container: missing required fields (groupJid, message)',
    );
  });
});

describe('checkDispatchRateLimit', () => {
  it('allows up to 5 dispatches per minute', () => {
    // Use a unique source group to avoid cross-test interference
    const source = `test-rate-${Date.now()}`;
    for (let i = 0; i < 5; i++) {
      expect(checkDispatchRateLimit(source)).toBe(true);
    }
    expect(checkDispatchRateLimit(source)).toBe(false);
  });

  it('rate limits per source group independently', () => {
    const sourceA = `rate-a-${Date.now()}`;
    const sourceB = `rate-b-${Date.now()}`;

    for (let i = 0; i < 5; i++) {
      checkDispatchRateLimit(sourceA);
    }
    expect(checkDispatchRateLimit(sourceA)).toBe(false);
    expect(checkDispatchRateLimit(sourceB)).toBe(true);
  });
});
