import { mkdir, readFile, writeFile, rm, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

export interface NetworkAttachment {
  jailId: string;
  ip: string;
  hostVeth: string;
  peerVeth: string;
}

export interface NetworkRecord {
  name: string;
  driver: string;
  createdAt: string;
  bridgeName?: string;
  subnet?: string;
  gateway?: string;
  allocations?: NetworkAttachment[];
  publishedPorts?: Array<{ hostPort: number; containerIp: string; containerPort: number; protocol: string }>;
}

export class NetworkManager {
  private baseDir: string;
  private networksDir: string;
  private metadataPath: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.networksDir = path.join(baseDir, "networks");
    this.metadataPath = path.join(this.networksDir, "networks.json");
  }

  async init(): Promise<void> {
    await mkdir(this.networksDir, { recursive: true });
    if (!existsSync(this.metadataPath)) await writeFile(this.metadataPath, "[]");
  }

  async create(name: string, driver = "bridge"): Promise<NetworkRecord> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) throw new Error(`invalid network name: ${name}`);
    const meta = await this.readMetadata();
    if (meta.some((n) => n.name === name)) throw new Error(`network already exists: ${name}`);
    const createdAt = new Date().toISOString();
    const record: NetworkRecord = { name, driver, createdAt, allocations: [], publishedPorts: [] };

    if (driver === "bridge" && process.platform === "linux" && this.commandExists("ip") && this.hasCapNetAdmin()) {
      const index = meta.filter((n) => n.driver === "bridge").length + 1;
      const subnetOctet = 88 + (index % 100);
      const subnet = `10.${subnetOctet}.0.0/24`;
      const gateway = `10.${subnetOctet}.0.1`;
      const bridgeName = `envia-br-${index}`;
      this.runIp(["link", "add", bridgeName, "type", "bridge"]);
      this.runIp(["addr", "add", `${gateway}/24`, "dev", bridgeName]);
      this.runIp(["link", "set", bridgeName, "up"]);
      try { execFileSync("sysctl", ["-w", "net.ipv4.ip_forward=1"], { stdio: "ignore" }); } catch { /* ignore */ }
      record.bridgeName = bridgeName;
      record.subnet = subnet;
      record.gateway = gateway;
    }

    meta.push(record);
    await this.writeMetadata(meta);
    return record;
  }

  async list(): Promise<Array<{ name: string; driver: string; createdAt: string }>> {
    return this.readMetadata();
  }

  async inspect(name: string): Promise<{ name: string; driver: string; createdAt: string }> {
    const meta = await this.readMetadata();
    const network = meta.find((n) => n.name === name);
    if (!network) throw new Error(`network not found: ${name}`);
    return network;
  }

  async remove(name: string): Promise<void> {
    const meta = await this.readMetadata();
    const network = meta.find((n) => n.name === name);
    if (!network) throw new Error(`network not found: ${name}`);
    if (network.bridgeName) {
      for (const allocation of network.allocations ?? []) {
        this.runIpSafe(["link", "delete", allocation.hostVeth]);
      }
      this.runIpSafe(["link", "delete", network.bridgeName]);
    }
    const next = meta.filter((n) => n.name !== name);
    await this.writeMetadata(next);
  }

  async attachJail(networkName: string, jailId: string, pid: number): Promise<NetworkAttachment> {
    const meta = await this.readMetadata();
    const network = meta.find((n) => n.name === networkName);
    if (!network || !network.bridgeName || !network.gateway || !network.subnet) {
      throw new Error(`network ${networkName} is not a bridge network`);
    }
    const prefix = network.subnet.split("/")[0].split(".").slice(0, 3).join(".");
    const used = new Set((network.allocations ?? []).map((a) => a.ip));
    let ip: string | undefined;
    for (let i = 2; i < 254; i++) {
      const candidate = `${prefix}.${i}`;
      if (!used.has(candidate)) { ip = candidate; break; }
    }
    if (!ip) throw new Error(`no IP addresses available in ${network.subnet}`);

    const hostVeth = `veth${jailId.slice(0, 8)}`;
    const peerVeth = `peer${jailId.slice(0, 8)}`;
    this.runIp(["link", "add", hostVeth, "type", "veth", "peer", "name", peerVeth]);
    this.runIp(["link", "set", peerVeth, "netns", String(pid)]);
    this.runNsenter(pid, ["ip", "addr", "add", `${ip}/24`, "dev", peerVeth]);
    this.runNsenter(pid, ["ip", "link", "set", peerVeth, "up"]);
    this.runNsenter(pid, ["ip", "route", "add", "default", "via", network.gateway]);
    this.runIp(["link", "set", hostVeth, "master", network.bridgeName]);
    this.runIp(["link", "set", hostVeth, "up"]);

    const attachment: NetworkAttachment = { jailId, ip, hostVeth, peerVeth };
    network.allocations = [...(network.allocations ?? []), attachment];
    await this.writeMetadata(meta);
    return attachment;
  }

  async detachJail(networkName: string, jailId: string): Promise<void> {
    const meta = await this.readMetadata();
    const network = meta.find((n) => n.name === networkName);
    if (!network) return;
    const allocation = (network.allocations ?? []).find((a) => a.jailId === jailId);
    if (allocation) {
      this.runIpSafe(["link", "delete", allocation.hostVeth]);
      network.allocations = (network.allocations ?? []).filter((a) => a.jailId !== jailId);
      await this.writeMetadata(meta);
    }
  }

  async findAllocation(networkName: string, jailId: string): Promise<NetworkAttachment | undefined> {
    const meta = await this.readMetadata();
    const network = meta.find((n) => n.name === networkName);
    return (network?.allocations ?? []).find((a) => a.jailId === jailId);
  }

  async publishPort(hostPort: number, containerIp: string, containerPort: number, protocol = "tcp"): Promise<void> {
    if (!this.commandExists("iptables")) throw new Error("port publishing requires iptables");
    this.runCommand("iptables", ["-t", "nat", "-A", "PREROUTING", "-p", protocol, "--dport", String(hostPort), "-j", "DNAT", "--to-destination", `${containerIp}:${containerPort}`]);
    this.runCommand("iptables", ["-A", "FORWARD", "-p", protocol, "-d", containerIp, "--dport", String(containerPort), "-j", "ACCEPT"]);
    const meta = await this.readMetadata();
    for (const network of meta) {
      if (network.allocations?.some((a) => a.ip === containerIp)) {
        network.publishedPorts = [...(network.publishedPorts ?? []), { hostPort, containerIp, containerPort, protocol }];
      }
    }
    await this.writeMetadata(meta);
  }

  private commandExists(command: string): boolean {
    try {
      execFileSync("command", ["-v", command], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  private hasCapNetAdmin(): boolean {
    try {
      const status = require("node:fs").readFileSync("/proc/self/status", "utf8");
      const match = status.match(/^CapEff:\s*([0-9a-f]+)$/m);
      if (!match) return false;
      const caps = BigInt(`0x${match[1]}`);
      return (caps & (1n << 12n)) !== 0n;
    } catch {
      return false;
    }
  }

  private runIp(args: string[]): void {
    execFileSync("ip", args, { stdio: "ignore" });
  }

  private runIpSafe(args: string[]): void {
    try { execFileSync("ip", args, { stdio: "ignore" }); } catch { /* ignore */ }
  }

  private runNsenter(pid: number, args: string[]): void {
    execFileSync("nsenter", ["-t", String(pid), "-n", "--", ...args], { stdio: "ignore" });
  }

  private runCommand(command: string, args: string[]): void {
    execFileSync(command, args, { stdio: "ignore" });
  }

  private async readMetadata(): Promise<NetworkRecord[]> {
    try {
      const raw = await readFile(this.metadataPath, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async writeMetadata(meta: NetworkRecord[]): Promise<void> {
    const tmp = `${this.metadataPath}.${crypto.randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(meta, null, 2));
    await rename(tmp, this.metadataPath);
  }
}