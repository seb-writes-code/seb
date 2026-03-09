/**
 * Cloud runtime implementation.
 * Manages agent VMs on remote infrastructure (Proxmox, EC2, etc.).
 * Communication via SSH, file sync via SCP.
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from '../logger.js';
import {
  Runtime,
  RuntimeConfig,
  RuntimeInstance,
  VolumeMount,
} from './runtime.js';

// Cloud config is read from ~/.config/nanoclaw/cloud-runtime.json
const CLOUD_CONFIG_PATH = path.join(
  os.homedir(),
  '.config',
  'nanoclaw',
  'cloud-runtime.json',
);

export interface CloudProviderConfig {
  provider: 'proxmox' | 'ec2';
}

export interface ProxmoxConfig extends CloudProviderConfig {
  provider: 'proxmox';
  /** Proxmox API URL, e.g. https://proxmox.local:8006 */
  apiUrl: string;
  /** API token in format user@realm!tokenid=secret */
  apiToken: string;
  /** Node name in the Proxmox cluster */
  node: string;
  /** Template VM ID to clone from */
  templateId: number;
  /** SSH key path for connecting to cloned VMs */
  sshKeyPath: string;
  /** SSH user for the VM (default: root) */
  sshUser?: string;
  /** VM memory in MB (default: 4096) */
  memory?: number;
  /** VM CPU cores (default: 2) */
  cores?: number;
  /** Storage for clone (default: local-lvm) */
  storage?: string;
  /** Skip TLS verification for self-signed certs (default: false) */
  insecure?: boolean;
}

export interface Ec2Config extends CloudProviderConfig {
  provider: 'ec2';
  region: string;
  instanceType: string;
  ami: string;
  sshKeyPath: string;
  sshUser?: string;
  securityGroupId?: string;
  subnetId?: string;
}

export type CloudConfig = ProxmoxConfig | Ec2Config;

function loadCloudConfig(): CloudConfig {
  if (!fs.existsSync(CLOUD_CONFIG_PATH)) {
    throw new Error(
      `Cloud runtime config not found at ${CLOUD_CONFIG_PATH}. ` +
        `Create it with your provider settings.`,
    );
  }
  return JSON.parse(fs.readFileSync(CLOUD_CONFIG_PATH, 'utf-8'));
}

/**
 * SSH-based RuntimeInstance.
 * Runs the agent-runner on a remote VM via SSH, piping stdin/stdout.
 */
class SshInstance implements RuntimeInstance {
  name: string;
  private sshProc: ChildProcess;
  private emitter = new EventEmitter();
  private vmId: string;
  private cleanup: () => Promise<void>;

  constructor(
    name: string,
    sshProc: ChildProcess,
    vmId: string,
    cleanup: () => Promise<void>,
  ) {
    this.name = name;
    this.sshProc = sshProc;
    this.vmId = vmId;
    this.cleanup = cleanup;
  }

  writeInput(data: string): void {
    this.sshProc.stdin!.write(data);
  }

  closeInput(): void {
    this.sshProc.stdin!.end();
  }

  kill(signal?: string): void {
    this.sshProc.kill(signal as NodeJS.Signals);
    this.cleanup().catch((err) =>
      logger.warn({ err, name: this.name }, 'Error during VM cleanup'),
    );
  }

  onStdout(handler: (data: Buffer) => void): void {
    this.sshProc.stdout!.on('data', handler);
  }

  onStderr(handler: (data: Buffer) => void): void {
    this.sshProc.stderr!.on('data', handler);
  }

  onClose(handler: (code: number | null) => void): void {
    this.sshProc.on('close', (code) => {
      this.cleanup()
        .catch((err) =>
          logger.warn({ err, name: this.name }, 'Error during VM cleanup'),
        )
        .finally(() => handler(code));
    });
  }

  onError(handler: (err: Error) => void): void {
    this.sshProc.on('error', (err) => {
      this.cleanup().catch(() => {});
      handler(err);
    });
  }

  async stop(): Promise<void> {
    this.sshProc.kill('SIGTERM');
    await this.cleanup();
  }
}

/**
 * Proxmox API helper.
 * Uses curl for HTTP requests to avoid adding npm dependencies.
 */
class ProxmoxApi {
  private apiUrl: string;
  private headers: string[];
  private node: string;
  private insecure: boolean;

  constructor(config: ProxmoxConfig) {
    this.apiUrl = config.apiUrl.replace(/\/$/, '');
    this.headers = [`Authorization: PVEAPIToken=${config.apiToken}`];
    this.node = config.node;
    this.insecure = config.insecure || false;
  }

  private curl(
    method: string,
    endpoint: string,
    data?: Record<string, string | number>,
  ): string {
    const url = `${this.apiUrl}/api2/json${endpoint}`;
    const args = ['-s', '-X', method];

    if (this.insecure) args.push('-k');
    for (const h of this.headers) {
      args.push('-H', h);
    }
    if (data) {
      for (const [key, val] of Object.entries(data)) {
        args.push('-d', `${key}=${val}`);
      }
    }
    args.push(url);

    return execSync(`curl ${args.map((a) => `'${a}'`).join(' ')}`, {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  /** Check API connectivity (throws on failure). */
  checkConnectivity(): void {
    this.curl('GET', '/cluster/resources?type=vm');
  }

  /** Clone a VM template, returning the new VMID. */
  cloneTemplate(
    templateId: number,
    name: string,
    opts: { memory?: number; cores?: number; storage?: string },
  ): number {
    // Find next available VMID
    const clusterRes = JSON.parse(
      this.curl('GET', '/cluster/resources?type=vm'),
    );
    const usedIds = new Set(
      (clusterRes.data || []).map((r: { vmid: number }) => r.vmid),
    );
    let newId = 100;
    while (usedIds.has(newId)) newId++;

    // Clone the template
    const cloneData: Record<string, string | number> = {
      newid: newId,
      name,
      full: 1, // Full clone (not linked)
    };
    if (opts.storage) cloneData.storage = opts.storage;

    this.curl(
      'POST',
      `/nodes/${this.node}/qemu/${templateId}/clone`,
      cloneData,
    );

    // Wait for clone task to complete
    this.waitForVm(newId, 'stopped', 120);

    // Configure resources
    const configData: Record<string, string | number> = {};
    if (opts.memory) configData.memory = opts.memory;
    if (opts.cores) configData.cores = opts.cores;
    if (Object.keys(configData).length > 0) {
      this.curl('PUT', `/nodes/${this.node}/qemu/${newId}/config`, configData);
    }

    return newId;
  }

  /** Start a VM. */
  startVm(vmId: number): void {
    this.curl('POST', `/nodes/${this.node}/qemu/${vmId}/status/start`);
  }

  /** Stop a VM. */
  stopVm(vmId: number): void {
    try {
      this.curl('POST', `/nodes/${this.node}/qemu/${vmId}/status/stop`);
    } catch {
      /* already stopped */
    }
  }

  /** Destroy a VM (stop + delete). */
  destroyVm(vmId: number): void {
    this.stopVm(vmId);
    this.waitForVm(vmId, 'stopped', 30);
    try {
      this.curl(
        'DELETE',
        `/nodes/${this.node}/qemu/${vmId}?purge=1&destroy-unreferenced-disks=1`,
      );
    } catch (err) {
      logger.warn({ err, vmId }, 'Failed to destroy VM');
    }
  }

  /** Get the IP address of a running VM via QEMU guest agent. */
  getVmIp(vmId: number): string | null {
    try {
      const res = JSON.parse(
        this.curl(
          'GET',
          `/nodes/${this.node}/qemu/${vmId}/agent/network-get-interfaces`,
        ),
      );
      const ifaces = res.data?.result || [];
      for (const iface of ifaces) {
        if (iface.name === 'lo') continue;
        for (const addr of iface['ip-addresses'] || []) {
          if (addr['ip-address-type'] === 'ipv4') {
            return addr['ip-address'];
          }
        }
      }
    } catch {
      /* guest agent not ready */
    }
    return null;
  }

  /** Wait for VM to reach a status. */
  private waitForVm(
    vmId: number,
    targetStatus: string,
    timeoutSecs: number,
  ): void {
    const deadline = Date.now() + timeoutSecs * 1000;
    while (Date.now() < deadline) {
      try {
        const res = JSON.parse(
          this.curl(
            'GET',
            `/nodes/${this.node}/qemu/${vmId}/status/current`,
          ),
        );
        if (res.data?.status === targetStatus) return;
        // Also check if lock is released (clone complete)
        if (targetStatus === 'stopped' && !res.data?.lock) return;
      } catch {
        /* VM may not exist yet */
      }
      execSync('sleep 2');
    }
    throw new Error(`VM ${vmId} did not reach ${targetStatus} in ${timeoutSecs}s`);
  }

  /** List all nanoclaw VMs (by name prefix). */
  listNanoclawVms(): Array<{ vmid: number; name: string; status: string }> {
    try {
      const res = JSON.parse(
        this.curl('GET', '/cluster/resources?type=vm'),
      );
      return (res.data || []).filter(
        (r: { name: string }) => r.name && r.name.startsWith('nanoclaw-'),
      );
    } catch {
      return [];
    }
  }
}

export class CloudRuntime implements Runtime {
  readonly type = 'cloud';
  private config: CloudConfig | null = null;

  private getConfig(): CloudConfig {
    if (!this.config) {
      this.config = loadCloudConfig();
    }
    return this.config;
  }

  ensureRunning(): void {
    const config = this.getConfig();

    if (config.provider === 'proxmox') {
      // Verify we can reach the Proxmox API
      const api = new ProxmoxApi(config);
      try {
        api.checkConnectivity();
        logger.debug('Proxmox API reachable');
      } catch (err) {
        throw new Error(
          `Cannot reach Proxmox API at ${config.apiUrl}: ${err instanceof Error ? err.message : err}`,
        );
      }

      // Check SSH key exists
      const keyPath = config.sshKeyPath.replace(/^~/, os.homedir());
      if (!fs.existsSync(keyPath)) {
        throw new Error(`SSH key not found at ${keyPath}`);
      }
    } else if (config.provider === 'ec2') {
      throw new Error(
        'EC2 cloud runtime not yet implemented. Use proxmox or docker.',
      );
    }
  }

  cleanupOrphans(): void {
    const config = this.getConfig();

    if (config.provider === 'proxmox') {
      const api = new ProxmoxApi(config);
      const vms = api.listNanoclawVms();
      for (const vm of vms) {
        if (vm.status === 'running' || vm.status === 'stopped') {
          try {
            api.destroyVm(vm.vmid);
          } catch {
            /* best effort */
          }
        }
      }
      if (vms.length > 0) {
        logger.info(
          { count: vms.length, names: vms.map((v) => v.name) },
          'Cleaned up orphaned cloud VMs',
        );
      }
    }
  }

  stopCommand(name: string): string {
    // For cloud VMs, stopping is done via API, not shell command.
    // Return a no-op; actual cleanup happens in SshInstance.
    return `echo "cloud VM ${name} cleanup handled via API"`;
  }

  async start(
    name: string,
    mounts: VolumeMount[],
    env: Record<string, string>,
    _config: RuntimeConfig,
  ): Promise<RuntimeInstance> {
    const config = this.getConfig();

    if (config.provider !== 'proxmox') {
      throw new Error(`Cloud provider ${config.provider} not yet implemented`);
    }

    return this.startProxmox(name, mounts, env, config);
  }

  private async startProxmox(
    name: string,
    mounts: VolumeMount[],
    env: Record<string, string>,
    config: ProxmoxConfig,
  ): Promise<RuntimeInstance> {
    const api = new ProxmoxApi(config);
    const sshUser = config.sshUser || 'root';
    const sshKey = config.sshKeyPath.replace(/^~/, os.homedir());

    // Remove internal env vars
    delete env._NANOCLAW_HOST_UID;
    delete env._NANOCLAW_HOST_GID;

    logger.info({ name, templateId: config.templateId }, 'Cloning Proxmox VM');

    // Clone template
    const vmId = api.cloneTemplate(config.templateId, name, {
      memory: config.memory || 4096,
      cores: config.cores || 2,
      storage: config.storage,
    });

    // Start the VM
    api.startVm(vmId);

    // Wait for VM to get an IP address (via QEMU guest agent)
    let vmIp: string | null = null;
    for (let i = 0; i < 60; i++) {
      vmIp = api.getVmIp(vmId);
      if (vmIp) break;
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (!vmIp) {
      api.destroyVm(vmId);
      throw new Error(
        `VM ${name} (${vmId}) did not get an IP address within 120s. ` +
          `Ensure QEMU guest agent is installed in the template.`,
      );
    }

    logger.info({ name, vmId, vmIp }, 'VM started, syncing files');

    const sshOpts = [
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'UserKnownHostsFile=/dev/null',
      '-o',
      'LogLevel=ERROR',
      '-i',
      sshKey,
    ];

    // Wait for SSH to be ready
    for (let i = 0; i < 30; i++) {
      try {
        execSync(
          `ssh ${sshOpts.map((o) => `'${o}'`).join(' ')} ${sshUser}@${vmIp} 'echo ready'`,
          { stdio: 'pipe', timeout: 5000 },
        );
        break;
      } catch {
        if (i === 29) {
          api.destroyVm(vmId);
          throw new Error(`SSH not ready on VM ${name} (${vmIp}) after 60s`);
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    // Sync mount contents to the VM via SCP
    for (const mount of mounts) {
      try {
        // Create target directory
        execSync(
          `ssh ${sshOpts.map((o) => `'${o}'`).join(' ')} ${sshUser}@${vmIp} 'mkdir -p ${mount.containerPath}'`,
          { stdio: 'pipe', timeout: 10000 },
        );
        // Copy contents
        execSync(
          `scp -r ${sshOpts.map((o) => `'${o}'`).join(' ')} '${mount.hostPath}/.' '${sshUser}@${vmIp}:${mount.containerPath}/'`,
          { stdio: 'pipe', timeout: 60000 },
        );
      } catch (err) {
        logger.warn(
          { mount: mount.containerPath, err },
          'Failed to sync mount to VM',
        );
      }
    }

    // Set environment variables on the VM
    const envScript = Object.entries(env)
      .map(([k, v]) => `export ${k}='${v.replace(/'/g, "'\\''")}'`)
      .join('; ');

    // SSH into the VM and run the entrypoint
    const sshProc = spawn(
      'ssh',
      [
        ...sshOpts,
        `${sshUser}@${vmIp}`,
        `${envScript}; /app/entrypoint.sh`,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    logger.info({ name, vmId, vmIp }, 'Agent started on cloud VM');

    const vmIdStr = String(vmId);

    // Cleanup function: sync writable mounts back, then destroy VM
    const cleanupVm = async () => {
      // Sync writable mounts back to host
      for (const mount of mounts) {
        if (mount.readonly) continue;
        try {
          execSync(
            `scp -r ${sshOpts.map((o) => `'${o}'`).join(' ')} '${sshUser}@${vmIp}:${mount.containerPath}/.' '${mount.hostPath}/'`,
            { stdio: 'pipe', timeout: 60000 },
          );
        } catch (err) {
          logger.warn(
            { mount: mount.containerPath, err },
            'Failed to sync mount back from VM',
          );
        }
      }

      // Destroy the VM
      try {
        api.destroyVm(vmId);
        logger.debug({ name, vmId }, 'Cloud VM destroyed');
      } catch (err) {
        logger.warn({ err, name, vmId }, 'Failed to destroy cloud VM');
      }
    };

    return new SshInstance(name, sshProc, vmIdStr, cleanupVm);
  }
}
