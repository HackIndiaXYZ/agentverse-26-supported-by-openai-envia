import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { Jailor } from "../src/runtime/jailor.js";
import { HostProcessBackend } from "../src/runtime/backends/host-process.js";
import { ImageStore } from "../src/images/store.js";
import { ImageBuilder } from "../src/images/builder.js";
import { VolumeManager } from "../src/volumes/manager.js";
import { NetworkManager } from "../src/network/manager.js";
import { JailhouseManager } from "../src/jailhouse/manager.js";

let tmp: string;
let jailor: Jailor;
let imageStore: ImageStore;
let volumeManager: VolumeManager;
let networkManager: NetworkManager;
let manager: JailhouseManager;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "envia-jh-"));
  jailor = new Jailor(tmp, new HostProcessBackend({ baseDir: tmp, allowUnsafeHostProcess: true }));
  await jailor.init();
  imageStore = new ImageStore(tmp);
  await imageStore.init();
  volumeManager = new VolumeManager(tmp);
  await volumeManager.init();
  networkManager = new NetworkManager(tmp);
  await networkManager.init();
  manager = new JailhouseManager(tmp, jailor, imageStore, volumeManager, networkManager, true);
  await manager.init();

  const ctx = path.join(tmp, "ctx");
  await fs.mkdir(ctx, { recursive: true });
  await fs.writeFile(path.join(ctx, "Jailfile"), "FROM scratch\n");
  const builder = new ImageBuilder(imageStore, { allowUnsafeHostProcess: true });
  await builder.build({ contextDir: ctx, tag: "jh:test" });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("Jailhouse", () => {
  it("validates and runs a two-service app", async () => {
    const config = {
      name: "testapp",
      services: {
        a: { image: "jh:test", command: process.execPath, args: ["-e", "console.log('a')"] },
        b: { image: "jh:test", command: process.execPath, args: ["-e", "console.log('b')"], depends_on: ["a"] },
      },
    };
    manager.validateConfig(config as any);
    const order = manager.startupOrder(config as any);
    expect(order).toEqual(["a", "b"]);

    const configPath = path.join(tmp, "jailhouse.json");
    await fs.writeFile(configPath, JSON.stringify(config));
    const state = await manager.up(config as any, configPath, { allowUnsafe: true });
    expect(Object.keys(state.services)).toEqual(["a", "b"]);
    expect(state.status).toBe("running");

    await new Promise((resolve) => setTimeout(resolve, 500));
    const ps = await manager.ps(state.name);
    expect(ps.services.a.state).toBe("stopped"); // short-lived process exits

    const logs = await manager.logs(state.name, undefined, 100);
    expect(logs.a.join("\n")).toContain("a");

    await new Promise((resolve) => setTimeout(resolve, 500));
    await manager.down(state.name, { volumes: true });
  });

  it("rejects cyclic dependencies", () => {
    const config = {
      name: "cycle",
      services: {
        a: { image: "jh:test", depends_on: ["b"] },
        b: { image: "jh:test", depends_on: ["a"] },
      },
    };
    expect(() => manager.validateConfig(config as any)).toThrow(/cyclic/);
  });
});