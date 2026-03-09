/**
 * Runtime factory for NanoClaw.
 * Returns cached runtime instances by type.
 */
import { CloudRuntime } from './cloud.js';
import { DockerRuntime } from './docker.js';
import { Runtime } from './runtime.js';

export type RuntimeType = 'docker' | 'qemu' | 'cloud';

const runtimes = new Map<RuntimeType, Runtime>();

/**
 * Get or create a runtime instance by type.
 * Instances are cached for reuse.
 */
export function getRuntime(type: RuntimeType = 'docker'): Runtime {
  let runtime = runtimes.get(type);
  if (runtime) return runtime;

  switch (type) {
    case 'docker':
      runtime = new DockerRuntime();
      break;
    case 'qemu':
      throw new Error(
        'QEMU runtime not yet implemented. Merge the qemu-runtime PR first.',
      );
    case 'cloud':
      runtime = new CloudRuntime();
      break;
    default:
      throw new Error(`Unknown runtime type: ${type}`);
  }

  runtimes.set(type, runtime);
  return runtime;
}

// Re-export types
export type {
  Runtime,
  RuntimeConfig,
  RuntimeInstance,
  VolumeMount,
} from './runtime.js';
