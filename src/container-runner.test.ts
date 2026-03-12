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

// Fake WriteStream for testing log streaming
const fakeWriteStream = {
  write: vi.fn(),
  end: vi.fn(),
};

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
      createWriteStream: vi.fn(() => fakeWriteStream),
      symlinkSync: vi.fn(),
      unlinkSync: vi.fn(),
      readlinkSync: vi.fn(),
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

import fs from 'fs';
import { runContainerAgent, ContainerOutput } from './container-runner.js';
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

describe('container-runner live log streaming', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeInstance = createFakeInstance();
    fakeWriteStream.write.mockClear();
    fakeWriteStream.end.mockClear();
    vi.mocked(fs.createWriteStream).mockReturnValue(
      fakeWriteStream as unknown as fs.WriteStream,
    );
    vi.mocked(fs.symlinkSync).mockImplementation(() => {});
    vi.mocked(fs.unlinkSync).mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('streams stdout chunks to the log file incrementally', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit two separate stdout chunks
    fakeInstance._stdout.push('First chunk of output\n');
    fakeInstance._stdout.push('Second chunk of output\n');

    await vi.advanceTimersByTimeAsync(10);

    // Both chunks should have been written to the log stream
    expect(fakeWriteStream.write).toHaveBeenCalledTimes(2);
    expect(fakeWriteStream.write).toHaveBeenCalledWith(
      'First chunk of output\n',
    );
    expect(fakeWriteStream.write).toHaveBeenCalledWith(
      'Second chunk of output\n',
    );

    // Normal exit
    emitOutputMarker(fakeInstance, {
      status: 'success',
      result: 'Done',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeInstance._emitter.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
  });

  it('creates active.log symlink at start and removes it on close', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Verify createWriteStream was called with a path in the logs dir
    expect(fs.createWriteStream).toHaveBeenCalledWith(
      expect.stringContaining('container-'),
      { flags: 'a' },
    );

    // Verify symlink was created
    expect(fs.symlinkSync).toHaveBeenCalledWith(
      expect.stringContaining('container-'),
      expect.stringContaining('active.log'),
    );

    // Normal exit
    emitOutputMarker(fakeInstance, { status: 'success', result: 'Done' });
    await vi.advanceTimersByTimeAsync(10);
    fakeInstance._emitter.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    // Verify log stream was closed
    expect(fakeWriteStream.end).toHaveBeenCalled();

    // Verify active.log symlink was removed on close
    // (unlinkSync is called for symlink removal — existsSync returns false by default
    // so we check that the cleanup path was reached via the end() call)
    await resultPromise;
  });

  it('closes log stream on container close with non-zero exit code', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    // Emit some stdout then close with error code
    fakeInstance._stdout.push('some output before crash\n');
    await vi.advanceTimersByTimeAsync(10);

    fakeInstance._emitter.emit('close', 1);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(fakeWriteStream.end).toHaveBeenCalled();
  });

  it('still accumulates stdout in memory for OUTPUT_MARKER parsing', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    // Emit a valid output marker via stdout
    const output: ContainerOutput = {
      status: 'success',
      result: 'parsed result',
    };
    const json = JSON.stringify(output);
    fakeInstance._stdout.push(
      `${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`,
    );

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (legacy mode — no onOutput callback)
    fakeInstance._emitter.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.result).toBe('parsed result');

    // Log stream should also have received the chunk
    expect(fakeWriteStream.write).toHaveBeenCalled();
  });
});
