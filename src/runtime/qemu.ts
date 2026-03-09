/**
 * QEMU/KVM runtime implementation.
 * Boots a VM with virtio-serial for stdin/stdout and 9p for file sharing.
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { logger } from '../logger.js';
import {
  Runtime,
  RuntimeConfig,
  RuntimeInstance,
  VolumeMount,
} from './runtime.js';

const QEMU_BIN = process.env.QEMU_BIN || 'qemu-system-x86_64';

// Default VM resources (overridable via env)
const QEMU_MEMORY = process.env.QEMU_MEMORY || '4G';
const QEMU_CPUS = process.env.QEMU_CPUS || '2';
const QEMU_BASE_IMAGE =
  process.env.QEMU_BASE_IMAGE || '/var/lib/nanoclaw/vm/nanoclaw-agent.qcow2';
const QEMU_OVERLAY_DIR =
  process.env.QEMU_OVERLAY_DIR || path.join(os.tmpdir(), 'nanoclaw-vm');

/**
 * Wraps a QEMU VM process as a RuntimeInstance.
 * Communication happens via a Unix socket (virtio-serial).
 */
class QemuInstance implements RuntimeInstance {
  name: string;
  private proc: ChildProcess;
  private socket: net.Socket | null = null;
  private socketPath: string;
  private overlayPath: string;
  private emitter = new EventEmitter();
  private connected = false;

  constructor(
    name: string,
    proc: ChildProcess,
    socketPath: string,
    overlayPath: string,
  ) {
    this.name = name;
    this.proc = proc;
    this.socketPath = socketPath;
    this.overlayPath = overlayPath;

    // Connect to virtio-serial socket
    this.connectSocket();
  }

  private connectSocket(): void {
    const tryConnect = (retries = 0) => {
      const sock = net.createConnection(this.socketPath);

      sock.on('connect', () => {
        this.socket = sock;
        this.connected = true;
        logger.debug({ name: this.name }, 'Connected to VM virtio-serial');
      });

      sock.on('data', (data: Buffer) => {
        this.emitter.emit('stdout', data);
      });

      sock.on('error', (err) => {
        if (!this.connected && retries < 30) {
          // VM may not be ready yet — retry after a short delay
          setTimeout(() => tryConnect(retries + 1), 500);
        } else if (this.connected) {
          this.emitter.emit('error', err);
        }
      });

      sock.on('close', () => {
        this.connected = false;
      });
    };

    tryConnect();
  }

  writeInput(data: string): void {
    if (this.socket && this.connected) {
      this.socket.write(data);
    } else {
      // Buffer until connected
      const waitForConnect = () => {
        if (this.socket && this.connected) {
          this.socket.write(data);
        } else {
          setTimeout(waitForConnect, 100);
        }
      };
      waitForConnect();
    }
  }

  closeInput(): void {
    if (this.socket) {
      this.socket.end();
    }
  }

  kill(signal?: string): void {
    this.proc.kill(signal as NodeJS.Signals);
    this.cleanup();
  }

  onStdout(handler: (data: Buffer) => void): void {
    this.emitter.on('stdout', handler);
  }

  onStderr(handler: (data: Buffer) => void): void {
    // QEMU stderr is VM console output — forward it
    this.proc.stderr?.on('data', handler);
  }

  onClose(handler: (code: number | null) => void): void {
    this.proc.on('close', (code) => {
      this.cleanup();
      handler(code);
    });
  }

  onError(handler: (err: Error) => void): void {
    this.emitter.on('error', handler);
    this.proc.on('error', (err) => {
      this.cleanup();
      handler(err);
    });
  }

  async stop(): Promise<void> {
    // Send ACPI shutdown via QEMU monitor (if available), fall back to kill
    try {
      this.proc.kill('SIGTERM');
      // Give 10s for graceful shutdown
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.proc.kill('SIGKILL');
          resolve();
        }, 10000);
        this.proc.on('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } catch {
      this.proc.kill('SIGKILL');
    }
    this.cleanup();
  }

  private cleanup(): void {
    // Remove the COW overlay (ephemeral per run)
    try {
      if (fs.existsSync(this.overlayPath)) {
        fs.unlinkSync(this.overlayPath);
      }
    } catch {
      /* best effort */
    }
    // Remove the socket file
    try {
      if (fs.existsSync(this.socketPath)) {
        fs.unlinkSync(this.socketPath);
      }
    } catch {
      /* best effort */
    }
  }
}

export class QemuRuntime implements Runtime {
  readonly type = 'qemu';

  ensureRunning(): void {
    try {
      execSync(`which ${QEMU_BIN}`, { stdio: 'pipe', timeout: 5000 });
    } catch {
      throw new Error(
        `QEMU not found. Install qemu-system-x86_64 or set QEMU_BIN env var.`,
      );
    }

    // Check KVM availability (optional but recommended)
    try {
      fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
      logger.debug('KVM acceleration available');
    } catch {
      logger.warn(
        'KVM not available — QEMU will run without hardware acceleration (slow)',
      );
    }

    // Check base image exists
    if (!fs.existsSync(QEMU_BASE_IMAGE)) {
      throw new Error(
        `QEMU base image not found at ${QEMU_BASE_IMAGE}. ` +
          `Run 'container/build-vm.sh' to create it, or set QEMU_BASE_IMAGE env var.`,
      );
    }
  }

  cleanupOrphans(): void {
    // Kill stale QEMU processes with nanoclaw- names
    try {
      const output = execSync(
        `pgrep -f 'qemu.*nanoclaw-' -a 2>/dev/null || true`,
        { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
      );
      const lines = output.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        const pid = line.split(/\s+/)[0];
        try {
          process.kill(parseInt(pid, 10), 'SIGTERM');
        } catch {
          /* already gone */
        }
      }
      if (lines.length > 0) {
        logger.info({ count: lines.length }, 'Stopped orphaned QEMU VMs');
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to clean up orphaned QEMU VMs');
    }

    // Clean up stale overlay files
    try {
      if (fs.existsSync(QEMU_OVERLAY_DIR)) {
        const files = fs.readdirSync(QEMU_OVERLAY_DIR);
        for (const file of files) {
          if (file.startsWith('nanoclaw-') && file.endsWith('.qcow2')) {
            fs.unlinkSync(path.join(QEMU_OVERLAY_DIR, file));
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to clean up stale VM overlays');
    }
  }

  stopCommand(name: string): string {
    // pkill by the QEMU -name argument
    return `pkill -f 'qemu.*-name ${name}'`;
  }

  async start(
    name: string,
    mounts: VolumeMount[],
    env: Record<string, string>,
    config: RuntimeConfig,
  ): Promise<RuntimeInstance> {
    // Create overlay directory
    fs.mkdirSync(QEMU_OVERLAY_DIR, { recursive: true });

    // Create COW overlay on the base image (fresh per run)
    const overlayPath = path.join(QEMU_OVERLAY_DIR, `${name}.qcow2`);
    const baseImage = config.image || QEMU_BASE_IMAGE;
    execSync(
      `qemu-img create -f qcow2 -b ${baseImage} -F qcow2 ${overlayPath}`,
      { stdio: 'pipe' },
    );

    // Create Unix socket path for virtio-serial
    const socketPath = path.join(QEMU_OVERLAY_DIR, `${name}.sock`);

    // Consume internal env vars (same as Docker)
    delete env._NANOCLAW_HOST_UID;
    delete env._NANOCLAW_HOST_GID;

    // Build QEMU command
    const args: string[] = [
      '-name',
      name,
      '-m',
      QEMU_MEMORY,
      '-smp',
      QEMU_CPUS,
      '-drive',
      `file=${overlayPath},format=qcow2,if=virtio`,
      '-nographic',
      '-no-reboot',
    ];

    // Enable KVM if available
    try {
      fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
      args.push('-enable-kvm');
    } catch {
      // Run without KVM (TCG emulation)
    }

    // Virtio-serial for stdin/stdout communication
    args.push(
      '-device',
      'virtio-serial-pci',
      '-chardev',
      `socket,id=agent,path=${socketPath},server=on,wait=off`,
      '-device',
      'virtserialport,chardev=agent,name=agent.0',
    );

    // 9p virtfs mounts for file sharing
    let mountIdx = 0;
    for (const mount of mounts) {
      const tag = `mount${mountIdx}`;
      const securityModel = mount.readonly ? 'none' : 'mapped-xattr';
      args.push(
        '-virtfs',
        `local,path=${mount.hostPath},mount_tag=${tag},security_model=${securityModel}${mount.readonly ? ',readonly=on' : ''}`,
      );
      mountIdx++;
    }

    // Pass env vars and mount metadata via kernel command line
    // (picked up by vm-init.sh in the guest)
    const envPairs = Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    const mountMeta = mounts
      .map((m, i) => `mount${i}:${m.containerPath}`)
      .join(',');
    args.push(
      '-append',
      `console=ttyS0 nanoclaw.env="${envPairs}" nanoclaw.mounts="${mountMeta}" quiet`,
    );

    logger.debug(
      {
        name,
        baseImage,
        overlayPath,
        socketPath,
        mountCount: mounts.length,
      },
      'Starting QEMU VM',
    );

    const proc = spawn(QEMU_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return new QemuInstance(name, proc, socketPath, overlayPath);
  }
}
