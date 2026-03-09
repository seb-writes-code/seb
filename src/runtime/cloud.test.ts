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
      readFileSync: vi.fn(() =>
        JSON.stringify({
          provider: 'proxmox',
          apiUrl: 'https://proxmox.local:8006',
          apiToken: 'user@pam!token=secret',
          node: 'pve',
          templateId: 9000,
          sshKeyPath: '/home/user/.ssh/nanoclaw',
        }),
      ),
      mkdirSync: vi.fn(),
    },
  };
});

import { CloudRuntime } from './cloud.js';
import fs from 'fs';

beforeEach(() => {
  vi.clearAllMocks();
  // Default: config file exists and SSH key exists
  vi.mocked(fs.existsSync).mockReturnValue(true);
});

describe('CloudRuntime', () => {
  it('has type "cloud"', () => {
    const runtime = new CloudRuntime();
    expect(runtime.type).toBe('cloud');
  });

  describe('ensureRunning', () => {
    it('succeeds when Proxmox API is reachable and SSH key exists', () => {
      // listNanoclawVms calls curl via execSync
      mockExecSync.mockReturnValueOnce(JSON.stringify({ data: [] }));

      const runtime = new CloudRuntime();
      expect(() => runtime.ensureRunning()).not.toThrow();
    });

    it('throws when config file not found', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const runtime = new CloudRuntime();
      expect(() => runtime.ensureRunning()).toThrow('config not found');
    });

    it('throws when Proxmox API is unreachable', () => {
      mockExecSync.mockImplementationOnce(() => {
        throw new Error('Connection refused');
      });

      const runtime = new CloudRuntime();
      expect(() => runtime.ensureRunning()).toThrow('Cannot reach Proxmox API');
    });

    it('throws when SSH key not found', () => {
      // API reachable
      mockExecSync.mockReturnValueOnce(JSON.stringify({ data: [] }));
      // existsSync: config exists, but SSH key does not
      vi.mocked(fs.existsSync)
        .mockReturnValueOnce(true) // config file
        .mockReturnValueOnce(false); // SSH key

      const runtime = new CloudRuntime();
      expect(() => runtime.ensureRunning()).toThrow('SSH key not found');
    });

    it('throws for EC2 provider (not yet implemented)', () => {
      vi.mocked(fs.readFileSync).mockReturnValueOnce(
        JSON.stringify({ provider: 'ec2', region: 'us-east-1' }),
      );

      const runtime = new CloudRuntime();
      expect(() => runtime.ensureRunning()).toThrow('not yet implemented');
    });
  });

  describe('stopCommand', () => {
    it('returns a no-op command (cleanup via API)', () => {
      const runtime = new CloudRuntime();
      const cmd = runtime.stopCommand('nanoclaw-test');
      expect(cmd).toContain('nanoclaw-test');
    });
  });

  describe('cleanupOrphans', () => {
    it('destroys orphaned Proxmox VMs', async () => {
      // listNanoclawVms
      mockExecSync.mockReturnValueOnce(
        JSON.stringify({
          data: [
            { vmid: 101, name: 'nanoclaw-old-1', status: 'running' },
            { vmid: 102, name: 'nanoclaw-old-2', status: 'stopped' },
          ],
        }),
      );
      // stopVm + waitForVm + destroyVm calls (multiple per VM)
      mockExecSync.mockReturnValue(
        JSON.stringify({ data: { status: 'stopped' } }),
      );

      const runtime = new CloudRuntime();
      runtime.cleanupOrphans();

      const { logger } = await import('../logger.js');
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ count: 2 }),
        'Cleaned up orphaned cloud VMs',
      );
    });

    it('does nothing when no orphans exist', () => {
      mockExecSync.mockReturnValueOnce(JSON.stringify({ data: [] }));

      const runtime = new CloudRuntime();
      runtime.cleanupOrphans();
    });
  });
});
