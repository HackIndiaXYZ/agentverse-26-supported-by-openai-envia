import { mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as yaml from "js-yaml";
import { Jailor } from "../runtime/jailor.js";
import { ImageStore } from "../images/store.js";
import { ImageBuilder } from "../images/builder.js";
import { VolumeManager } from "../volumes/manager.js";
import { NetworkManager } from "../network/manager.js";
import type { JailhouseConfig, JailhouseApplicationState, JailhouseServiceState, JailhouseService } from "./types.js";

export class JailhouseManager {
  private baseDir: string;
  private jailor: Jailor;
  private imageStore: ImageStore;
  private volumeManager: VolumeManager;
  private networkManager: NetworkManager;
  private builder: ImageBuilder;

  constructor(baseDir: string, jailor: Jailor, imageStore: ImageStore, volumeManager: VolumeManager, networkManager: NetworkManager, allowUnsafe: boolean) {
    this.baseDir = baseDir;
    this.jailor = jailor;
    this.imageStore = imageStore;
    this.volumeManager = volumeManager;
    this.networkManager = networkManager;
    this.builder = new ImageBuilder(imageStore, { allowUnsafeHostProcess: allowUnsafe });
  }

  private appDir(name: string): string {
    return path.join(this.baseDir, "jailhouse", name);
  }

  private statePath(name: string): string {
    return path.join(this.appDir(name), "state.json");
  }

  async init(): Promise<void> {
    await mkdir(path.join(this.baseDir, "jailhouse"), { recursive: true });
  }

  parseConfig(text: string, filename: string): JailhouseConfig {
    let parsed: any;
    if (filename.endsWith(".json")) {
      parsed = JSON.parse(text);
    } else {
      parsed = yaml.load(text);
    }
    if (!parsed || typeof parsed !== "object" || !parsed.services || typeof parsed.services !== "object") {
      throw new Error("jailhouse config must contain a services object");
    }
    return parsed as JailhouseConfig;
  }

  validateConfig(config: JailhouseConfig): void {
    if (!config.services || Object.keys(config.services).length === 0) throw new Error("at least one service is required");
    for (const [name, service] of Object.entries(config.services)) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) throw new Error(`invalid service name: ${name}`);
      if (!service.image && !service.build) throw new Error(`service ${name} requires image or build`);
    }
    // cycle detection
    this.startupOrder(config);
  }

  startupOrder(config: JailhouseConfig): string[] {
    const services = Object.keys(config.services);
    const deps = new Map<string, string[]>();
    for (const [name, service] of Object.entries(config.services)) {
      const raw = service.depends_on;
      let list: string[] = [];
      if (Array.isArray(raw)) list = raw as string[];
      else if (raw && typeof raw === "object") list = Object.keys(raw);
      deps.set(name, list);
      for (const dep of list) {
        if (!config.services[dep]) throw new Error(`service ${name} depends on unknown service ${dep}`);
      }
    }
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const order: string[] = [];
    const visit = (name: string) => {
      if (visited.has(name)) return;
      if (visiting.has(name)) throw new Error(`cyclic dependency involving ${name}`);
      visiting.add(name);
      for (const dep of deps.get(name) ?? []) visit(dep);
      visiting.delete(name);
      visited.add(name);
      order.push(name);
    };
    for (const name of services) visit(name);
    return order;
  }

  private parseMemory(value?: string): number | undefined {
    if (!value) return undefined;
    const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(b|k|m|g)?$/i);
    if (!match) return undefined;
    const num = Number(match[1]);
    const unit = (match[2] ?? "b").toLowerCase();
    const factor = unit === "g" ? 1024 ** 3 : unit === "m" ? 1024 ** 2 : unit === "k" ? 1024 : 1;
    return Math.floor(num * factor);
  }

  private parsePorts(service: JailhouseService): Array<{ published: number | string; target: number | string; protocol: "tcp" | "udp" }> {
    return (service.ports ?? []).map((entry) => {
      if (typeof entry === "string") {
        const [left, right] = entry.split(":");
        if (right) return { published: left, target: right, protocol: "tcp" };
        return { published: left, target: left, protocol: "tcp" };
      }
      return { published: entry.published, target: entry.target, protocol: entry.protocol ?? "tcp" };
    });
  }

  private parseVolumes(service: JailhouseService): Array<{ source: string; target: string; readOnly: boolean }> {
    return (service.volumes ?? []).map((entry) => {
      const parts = entry.split(":");
      const source = parts[0];
      const target = parts[1];
      const readOnly = parts[2] === "ro";
      return { source, target, readOnly };
    });
  }

  private async resolveVolumeSource(source: string): Promise<string> {
    if (path.isAbsolute(source)) return source;
    try {
      await this.volumeManager.inspect(source);
      return this.volumeManager.path(source);
    } catch {
      // create named volume on demand
      try {
        const created = await this.volumeManager.create(source);
        return created.path;
      } catch {
        return path.resolve(process.cwd(), source);
      }
    }
  }

  private async buildServiceImage(appName: string, serviceName: string, service: JailhouseService, allowUnsafe: boolean): Promise<string> {
    if (service.image) return service.image;
    if (!service.build) throw new Error(`service ${serviceName} has no image or build`);
    const contextDir = path.resolve(process.cwd(), service.build.context);
    const tag = `envia-jailhouse-${appName}-${serviceName}:latest`;
    const builder = new ImageBuilder(this.imageStore, { allowUnsafeHostProcess: allowUnsafe });
    const manifest = await builder.build({
      contextDir,
      jailfilePath: service.build.jailfile ? path.resolve(process.cwd(), service.build.jailfile) : undefined,
      tag,
    });
    return tag;
  }

  async up(config: JailhouseConfig, configPath: string, options: { detach?: boolean; profiles?: string[]; allowUnsafe?: boolean } = {}): Promise<JailhouseApplicationState> {
    this.validateConfig(config);
    const appName = config.name ?? path.basename(path.dirname(configPath)) ?? "app";
    await mkdir(this.appDir(appName), { recursive: true });
    const allowUnsafe = options.allowUnsafe ?? false;

    // networks
    const networkNames: string[] = [];
    for (const [name, net] of Object.entries(config.networks ?? {})) {
      if (net?.external) {
        networkNames.push(name);
        continue;
      }
      await this.networkManager.create(name, net?.driver ?? "bridge").catch(() => undefined);
      networkNames.push(name);
    }
    // volumes
    const volumeNames: string[] = [];
    for (const name of Object.keys(config.volumes ?? {})) {
      const vol = (config.volumes as any)[name];
      if (vol?.external) {
        volumeNames.push(name);
        continue;
      }
      await this.volumeManager.create(name).catch(() => undefined);
      volumeNames.push(name);
    }

    const order = this.startupOrder(config);
    const state: JailhouseApplicationState = {
      name: appName,
      configPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      services: {},
      networks: networkNames,
      volumes: volumeNames,
      status: "running",
    };

    const isolationEnforced = this.jailor.capabilities().isolation === "enforced";

    try {
      for (const serviceName of order) {
        const service = config.services[serviceName];
        const imageRef = await this.buildServiceImage(appName, serviceName, service, allowUnsafe);
        const image = await this.imageStore.resolve(imageRef);

        const env: Record<string, string> = { ...(service.environment ?? {}) };
        if (service.env_file) {
          const files = Array.isArray(service.env_file) ? service.env_file : [service.env_file];
          for (const file of files) {
            const raw = await readFile(path.resolve(process.cwd(), file), "utf8");
            for (const line of raw.split(/\r?\n/)) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith("#")) continue;
              const idx = trimmed.indexOf("=");
              if (idx !== -1) env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
            }
          }
        }

        let command: string | undefined;
        let args: string[] = [];
        if (Array.isArray(service.command)) {
          command = service.command[0];
          args = service.command.slice(1);
        } else if (typeof service.command === "string") {
          command = service.command;
        }
        if (service.args) args = [...args, ...service.args];
        if (!command) {
          const cmd = image.manifest.config.entrypoint?.length ? image.manifest.config.entrypoint : image.manifest.config.cmd;
          if (Array.isArray(cmd) && cmd.length) {
            command = cmd[0];
            args = cmd.slice(1);
          }
        }
        if (!command) throw new Error(`service ${serviceName} has no command`);

        const mounts = this.parseVolumes(service).map((m) => ({ source: m.source, target: m.target, readOnly: m.readOnly }));
        // resolve volume sources
        for (const m of mounts) {
          m.source = await this.resolveVolumeSource(m.source);
        }
        if (service.mounts) {
          for (const m of service.mounts) {
            mounts.push({ source: m.source, target: m.target, readOnly: m.readOnly ?? false });
          }
        }

        const jail = await this.jailor.createJail({
          name: `${appName}-${serviceName}`,
          command,
          args,
          env,
          workingDirectory: service.working_dir ?? image.manifest.config.workingDir,
          mounts,
          networks: (service.networks ?? []).filter((n) => n !== "none"),
          publishedPorts: this.parsePorts(service).map((p) => ({ hostPort: p.published, containerPort: p.target, protocol: p.protocol })),
          networkMode: service.networks?.includes("none") ? "none" : (service.networks?.length ? "bridge" : "host"),
          limits: {
            cpuMillis: service.cpu ? Math.floor(service.cpu * 1000) : undefined,
            memoryBytes: this.parseMemory(service.memory),
            pids: service.pids,
            runtimeMs: service.runtime_ms,
          },
          isolationRequired: isolationEnforced,
          allowUnsafeHostProcess: !isolationEnforced || allowUnsafe,
          rootfsPath: image.rootfsPath,
        });

        const started = await this.jailor.startJail(jail.id);
        const serviceState: JailhouseServiceState = {
          name: serviceName,
          jailId: jail.id,
          imageDigest: image.digest,
          state: started.state as any,
          exitCode: started.exitCode,
          startedAt: started.startedAt,
          health: service.healthcheck ? "starting" : "none",
          restartCount: 0,
        };
        state.services[serviceName] = serviceState;

        // health check
        if (service.healthcheck?.test) {
          const healthy = await this.runHealthCheck(jail.id, service.healthcheck, allowUnsafe);
          serviceState.health = healthy ? "healthy" : "unhealthy";
          if (!healthy && service.restart === "always") {
            await this.jailor.stopJail(jail.id).catch(() => undefined);
            const restarted = await this.jailor.startJail(jail.id);
            serviceState.restartCount = (serviceState.restartCount ?? 0) + 1;
            serviceState.state = restarted.state as any;
          }
        }
      }

      state.updatedAt = new Date().toISOString();
      await writeFile(this.statePath(appName), JSON.stringify(state, null, 2));
      return state;
    } catch (err) {
      // cleanup created services
      for (const serviceState of Object.values(state.services)) {
        if (serviceState.jailId) {
          await this.jailor.removeJail(serviceState.jailId).catch(() => undefined);
        }
      }
      state.status = "failed";
      state.updatedAt = new Date().toISOString();
      await writeFile(this.statePath(appName), JSON.stringify(state, null, 2)).catch(() => undefined);
      throw err;
    }
  }

  private async runHealthCheck(jailId: string, healthcheck: NonNullable<JailhouseService["healthcheck"]>, _allowUnsafe: boolean): Promise<boolean> {
    const test = healthcheck.test;
    let command: string;
    let args: string[] = [];
    if (Array.isArray(test)) {
      if (test[0] === "CMD-SHELL") {
        command = "/bin/sh";
        args = ["-c", test.slice(1).join(" ")];
      } else if (test[0] === "CMD") {
        command = test[1] ?? "/bin/sh";
        args = test.slice(2);
      } else {
        command = test[0];
        args = test.slice(1);
      }
    } else {
      command = "/bin/sh";
      args = ["-c", test as string];
    }
    const retries = healthcheck.retries ?? 3;
    for (let i = 0; i < retries; i++) {
      try {
        const result = await this.jailor.execJail(jailId, command, args, { timeoutMs: 5000 });
        if (result.exitCode === 0) return true;
      } catch {
        // ignore
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }

  async down(appName: string, options: { volumes?: boolean; removeImages?: boolean } = {}): Promise<void> {
    const state = await this.readState(appName);
    const serviceNames = Object.keys(state.services).reverse();
    for (const name of serviceNames) {
      const serviceState = state.services[name];
      if (serviceState.jailId) {
        await this.jailor.removeJail(serviceState.jailId).catch(() => undefined);
        serviceState.state = "removed";
      }
    }
    for (const network of state.networks) {
      await this.networkManager.remove(network).catch(() => undefined);
    }
    if (options.volumes) {
      for (const volume of state.volumes) {
        await this.volumeManager.remove(volume).catch(() => undefined);
      }
    }
    state.status = "stopped";
    state.updatedAt = new Date().toISOString();
    await writeFile(this.statePath(appName), JSON.stringify(state, null, 2));
  }

  async ps(appName: string): Promise<JailhouseApplicationState> {
    const state = await this.readState(appName);
    for (const serviceState of Object.values(state.services)) {
      if (serviceState.jailId) {
        try {
          const jail = await this.jailor.inspectJail(serviceState.jailId);
          serviceState.state = jail.state as any;
          serviceState.exitCode = jail.exitCode;
        } catch {
          serviceState.state = "removed";
        }
      }
    }
    state.updatedAt = new Date().toISOString();
    await writeFile(this.statePath(appName), JSON.stringify(state, null, 2));
    return state;
  }

  async logs(appName: string, service?: string, lines = 100): Promise<Record<string, string[]>> {
    const state = await this.readState(appName);
    const result: Record<string, string[]> = {};
    const names = service ? [service] : Object.keys(state.services);
    for (const name of names) {
      const serviceState = state.services[name];
      if (serviceState?.jailId) {
        result[name] = await this.jailor.logs(serviceState.jailId, lines);
      } else {
        result[name] = [];
      }
    }
    return result;
  }

  async readState(appName: string): Promise<JailhouseApplicationState> {
    const raw = await readFile(this.statePath(appName), "utf8");
    return JSON.parse(raw) as JailhouseApplicationState;
  }

  async listApps(): Promise<string[]> {
    const dir = path.join(this.baseDir, "jailhouse");
    if (!existsSync(dir)) return [];
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  }
}