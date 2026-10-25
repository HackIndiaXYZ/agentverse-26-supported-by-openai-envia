import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { ImageStore } from "../src/images/store.js";
import { ImageBuilder } from "../src/images/builder.js";
import { parseJailfile } from "../src/images/jailfile.js";

let tmp: string;
let store: ImageStore;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "envia-img-"));
  store = new ImageStore(tmp);
  await store.init();
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("Jailfile parsing", () => {
  it("parses basic instructions", () => {
    const instructions = parseJailfile("FROM scratch\nWORKDIR /app\nCOPY . /app\nCMD [\"node\",\"app.js\"]");
    expect(instructions.map((i) => i.type)).toEqual(["FROM", "WORKDIR", "COPY", "CMD"]);
  });

  it("rejects missing FROM", () => {
    expect(() => parseJailfile("RUN echo hi")).toThrow(/FROM/);
  });

  it("rejects unknown instructions", () => {
    expect(() => parseJailfile("FROM scratch\nFOO bar")).toThrow(/unknown instruction/);
  });
});

describe("Image build and store", () => {
  it("builds, tags, lists, and inspects an image", async () => {
    const ctx = path.join(tmp, "ctx");
    await fs.mkdir(ctx, { recursive: true });
    await fs.writeFile(path.join(ctx, "app.js"), "console.log('hi')");
    await fs.writeFile(path.join(ctx, "Jailfile"), "FROM scratch\nCOPY . /app\n");

    const builder = new ImageBuilder(store, { allowUnsafeHostProcess: false });
    const manifest = await builder.build({ contextDir: ctx, tag: "demo:latest" });
    expect(manifest.digest).toMatch(/^[0-9a-f]{64}$/);

    const images = await store.list();
    expect(images.length).toBeGreaterThan(0);

    const inspected = await store.inspect("demo:latest");
    expect((inspected as any).digest).toBe(manifest.digest);
  });

  it("caches repeated builds", async () => {
    const ctx = path.join(tmp, "ctx2");
    await fs.mkdir(ctx, { recursive: true });
    await fs.writeFile(path.join(ctx, "Jailfile"), "FROM scratch\n");

    const builder = new ImageBuilder(store, { allowUnsafeHostProcess: false });
    const first = await builder.build({ contextDir: ctx, tag: "cache:test" });
    const second = await builder.build({ contextDir: ctx, tag: "cache:test2" });
    expect(second.digest).toBe(first.digest);
  });

  it("requires unsafe mode for RUN", async () => {
    const ctx = path.join(tmp, "ctx3");
    await fs.mkdir(ctx, { recursive: true });
    await fs.writeFile(path.join(ctx, "Jailfile"), "FROM scratch\nRUN echo hi\n");

    const builder = new ImageBuilder(store, { allowUnsafeHostProcess: false });
    await expect(builder.build({ contextDir: ctx })).rejects.toThrow(/unsafe/);
  });

  it("rejects COPY path traversal", async () => {
    const ctx = path.join(tmp, "ctx4");
    await fs.mkdir(ctx, { recursive: true });
    await fs.writeFile(path.join(ctx, "Jailfile"), "FROM scratch\nCOPY ../secret /app\n");

    const builder = new ImageBuilder(store, { allowUnsafeHostProcess: false });
    await expect(builder.build({ contextDir: ctx })).rejects.toThrow(/escapes build context/);
  });

  it("exports and imports an image", async () => {
    const ctx = path.join(tmp, "ctx5");
    await fs.mkdir(ctx, { recursive: true });
    await fs.writeFile(path.join(ctx, "Jailfile"), "FROM scratch\n");
    const builder = new ImageBuilder(store, { allowUnsafeHostProcess: false });
    const manifest = await builder.build({ contextDir: ctx, tag: "export:test" });

    const archive = path.join(tmp, "image.tar.gz");
    await store.exportImage("export:test", archive);
    const importedDigest = await store.importImage(archive);
    expect(importedDigest).toBe(manifest.digest);
  });

  it("removes an image", async () => {
    const ctx = path.join(tmp, "ctx6");
    await fs.mkdir(ctx, { recursive: true });
    await fs.writeFile(path.join(ctx, "Jailfile"), "FROM scratch\n");
    const builder = new ImageBuilder(store, { allowUnsafeHostProcess: false });
    await builder.build({ contextDir: ctx, tag: "rm:test" });
    await store.remove("rm:test");
    await expect(store.resolve("rm:test")).rejects.toThrow();
  });
});