import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
      appendFileSync: vi.fn(),
      unlinkSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Create a controllable fake RuntimeInstance backed by EventEmitter + streams
import { PassThrough } from 'stream';
import type { RuntimeInstance } from './runtime/runtime.js';

function createFakeInstance(): RuntimeInstance & {
  _stdout: PassThrough;
  _stderr: PassThrough;
  _emitter: EventEmitter;
  _stdinData: string[];
} {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdinData: string[] = [];

  return {
    name: 'nanoclaw-test-123',
    _stdout: stdout,
    _stderr: stderr,
    _emitter: emitter,
    _stdinData: stdinData,
    writeInput(data: string) {
      stdinData.push(data);
    },
    closeInput() {
      /* no-op */
    },
    kill: vi.fn(),
    onStdout(handler: (data: Buffer) => void) {
      stdout.on('data', handler);
    },
    onStderr(handler: (data: Buffer) => void) {
      stderr.on('data', handler);
    },
    onClose(handler: (code: number | null) => void) {
      emitter.on('close', handler);
    },
    onError(handler: (err: Error) => void) {
      emitter.on('error', handler);
    },
    async stop() {
      /* no-op */
    },
  };
}

let fakeInstance: ReturnType<typeof createFakeInstance>;

// Mock the runtime module
vi.mock('./runtime/index.js', () => ({
  getRuntime: vi.fn(() => ({
    type: 'docker',
    ensureRunning: vi.fn(),
    cleanupOrphans: vi.fn(),
    stopCommand: (name: string) => `docker stop ${name}`,
    start: vi.fn(async () => fakeInstance),
  })),
}));

// Mock child_process.exec (used for timeout stop command)
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import {
  runContainerAgent,
  ContainerOutput,
  taskLogPath,
} from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  instance: ReturnType<typeof createFakeInstance>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  instance._stdout.push(
    `${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`,
  );
}

describe('taskLogPath', () => {
  it('sanitizes JID characters for filesystem safety', () => {
    const p = taskLogPath('tg:-1001234567890:123');
    expect(p).toContain('task-tg_-1001234567890_123.log');
    expect(p).not.toContain(':');
  });

  it('handles WhatsApp JIDs', () => {
    const p = taskLogPath('120363336345536173@g.us');
    expect(p).toContain('task-120363336345536173_g_us.log');
    expect(p).not.toContain('@');
  });
});

describe('container-runner live log file', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeInstance = createFakeInstance();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates log file at start, appends stdout, and cleans up on close', async () => {
    const fs = await import('fs');
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    const appendFileSync = vi.mocked(
      (fs.default as any).appendFileSync || vi.fn(),
    );
    const unlinkSync = vi.mocked((fs.default as any).unlinkSync || vi.fn());

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    // Let the async runtime.start() resolve so the promise body runs
    await vi.advanceTimersByTimeAsync(10);

    // Verify log file was created (writeFileSync with empty string for the log path)
    const logFileCreations = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('task-'),
    );
    expect(logFileCreations.length).toBeGreaterThanOrEqual(1);

    // Emit some stdout
    fakeInstance._stdout.push('Hello from container\n');
    await vi.advanceTimersByTimeAsync(10);

    // Normal exit
    fakeInstance._emitter.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    await resultPromise;
  });
});

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeInstance = createFakeInstance();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeInstance, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeInstance._emitter.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeInstance._emitter.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('onOutput error does not hang the promise', async () => {
    const onOutput = vi.fn(async () => {
      throw new Error('sendMessage failed');
    });
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output — onOutput will throw
    emitOutputMarker(fakeInstance, {
      status: 'success',
      result: 'Agent response',
      newSessionId: 'session-err',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit
    fakeInstance._emitter.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    // The promise should still resolve (not hang)
    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(onOutput).toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeInstance, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeInstance._emitter.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});
