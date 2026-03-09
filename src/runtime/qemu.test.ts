import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  spawn: vi.fn(),
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      accessSync: vi.fn(),
      mkdirSync: vi.fn(),
      unlinkSync: vi.fn(),
      readdirSync: vi.fn(() => []),
    },
  };
});

import { QemuRuntime } from './qemu.js';
import fs from 'fs';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('QemuRuntime', () => {
  it('has type "qemu"', () => {
    const runtime = new QemuRuntime();
    expect(runtime.type).toBe('qemu');
  });

  describe('ensureRunning', () => {
    it('succeeds when QEMU binary and base image exist', () => {
      mockExecSync.mockReturnValueOnce('/usr/bin/qemu-system-x86_64');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.accessSync).mockImplementation(() => {});

      const runtime = new QemuRuntime();
      expect(() => runtime.ensureRunning()).not.toThrow();
    });

    it('throws when QEMU binary not found', () => {
      mockExecSync.mockImplementationOnce(() => {
        throw new Error('not found');
      });

      const runtime = new QemuRuntime();
      expect(() => runtime.ensureRunning()).toThrow('QEMU not found');
    });

    it('throws when base image not found', () => {
      mockExecSync.mockReturnValueOnce('/usr/bin/qemu-system-x86_64');
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const runtime = new QemuRuntime();
      expect(() => runtime.ensureRunning()).toThrow('base image not found');
    });

    it('warns when KVM is not available', async () => {
      mockExecSync.mockReturnValueOnce('/usr/bin/qemu-system-x86_64');
      vi.mocked(fs.accessSync).mockImplementation(() => {
        throw new Error('EACCES');
      });
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const runtime = new QemuRuntime();
      runtime.ensureRunning();

      const { logger } = await import('../logger.js');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('KVM not available'),
      );
    });
  });

  describe('stopCommand', () => {
    it('returns pkill command targeting QEMU by name', () => {
      const runtime = new QemuRuntime();
      const cmd = runtime.stopCommand('nanoclaw-test-123');
      expect(cmd).toBe("pkill -f 'qemu.*-name nanoclaw-test-123'");
    });
  });

  describe('cleanupOrphans', () => {
    it('kills orphaned QEMU processes', () => {
      // pgrep returns PIDs
      mockExecSync.mockReturnValueOnce(
        '12345 qemu-system-x86_64 -name nanoclaw-old\n',
      );

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const runtime = new QemuRuntime();
      runtime.cleanupOrphans();

      expect(killSpy).toHaveBeenCalledWith(12345, 'SIGTERM');
      killSpy.mockRestore();
    });

    it('cleans up stale overlay files', () => {
      mockExecSync.mockReturnValueOnce('');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.readdirSync).mockReturnValue([
        'nanoclaw-old-123.qcow2',
      ] as any);

      const runtime = new QemuRuntime();
      runtime.cleanupOrphans();

      expect(fs.unlinkSync).toHaveBeenCalled();
    });
  });
});
