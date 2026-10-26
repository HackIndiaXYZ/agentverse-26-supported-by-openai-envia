import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { RetentionManager } from "../src/retention/manager.js";

let tmp: string;
let manager: RetentionManager;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "envia-ret-"));
  manager = new RetentionManager(tmp);
  await manager.init();
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("Retention", () => {
  it("previews and cleans orphaned temp dirs", async () => {
    const orphan = path.join(tmp, ".restore-old");
    await fs.mkdir(orphan, { recursive: true });
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await fs.utimes(orphan, old, old);
    const preview = await manager.preview();
    expect(preview.orphanedTempDirs).toContain(".restore-old");
    const result = await manager.cleanup(false);
    expect(result.removedTempDirs).toContain(".restore-old");
    expect((await fs.readdir(tmp)).includes(".restore-old")).toBe(false);
  });
});