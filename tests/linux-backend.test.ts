import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { LinuxNamespaceBackend } from "../src/runtime/backends/linux-namespace.js";

describe("Linux namespace backend", () => {
  it("reports capabilities honestly", () => {
    const backend = new LinuxNamespaceBackend({ baseDir: os.tmpdir(), allowUnsafe: true });
    const caps = backend.capabilities();
    if (process.platform === "linux") {
      // Capability may be enforced or unsupported depending on unshare availability.
      expect(["enforced", "unsupported"]).toContain(caps.isolation);
    } else {
      expect(caps.isolation).toBe("unsupported");
      expect(caps.network).toBe("unsupported");
      expect(caps.resourceLimits).toBe("unsupported");
    }
  });

  it("fails closed on non-Linux platforms", async () => {
    if (process.platform === "linux") return;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "envia-linux-"));
    const backend = new LinuxNamespaceBackend({ baseDir: tmp, allowUnsafe: true });
    await expect(backend.createJail({
      name: "test",
      command: "true",
      isolationRequired: false,
      allowUnsafeHostProcess: true,
    } as any)).rejects.toThrow(/requires Linux/);
    await fs.rm(tmp, { recursive: true, force: true });
  });
});