import { HostProcessBackend } from "./backends/host-process.js";
import { LinuxNamespaceBackend } from "./backends/linux-namespace.js";
import { NetworkManager } from "../network/manager.js";

export type BackendName = "host-process" | "linux-namespace";

export interface BackendFactoryOptions {
  baseDir: string;
  backend?: BackendName;
  allowUnsafeHostProcess?: boolean;
  allowUnsafeLinux?: boolean;
}

export function createBackend(options: BackendFactoryOptions) {
  const requested = options.backend
    ?? (process.env.ENVIA_RUNTIME_BACKEND as BackendName | undefined)
    ?? (process.platform === "linux" ? "linux-namespace" : "host-process");

  switch (requested) {
    case "linux-namespace": {
      const networkManager = new NetworkManager(options.baseDir);
      // Best-effort init; backend may be used in tests without init.
      void networkManager.init().catch(() => undefined);
      return new LinuxNamespaceBackend({ baseDir: options.baseDir, allowUnsafe: options.allowUnsafeLinux ?? false, networkManager });
    }
    case "host-process":
    default:
      return new HostProcessBackend({ baseDir: options.baseDir, allowUnsafeHostProcess: options.allowUnsafeHostProcess ?? false });
  }
}

export function backendNames(): BackendName[] {
  return ["host-process", "linux-namespace"];
}