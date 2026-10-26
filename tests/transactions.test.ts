import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { TransactionManager } from "../src/transactions/manager.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "envia-txtest-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

async function sha256File(filePath: string): Promise<string> {
  return crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function createTransaction(state: string, options: { completed?: string[]; removeBackup?: boolean; mutateAfterApply?: boolean } = {}): Promise<{ id: string; projectDir: string }> {
  const projectDir = path.join(tmp, "project");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, "app.txt"), "hello");

  const txId = crypto.randomUUID();
  const txDir = path.join(tmp, "transactions", txId);
  await fs.mkdir(path.join(txDir, "staged"), { recursive: true });
  await fs.mkdir(path.join(txDir, "backups"), { recursive: true });
  const stagedPath = path.join(txDir, "staged", "app.txt");
  const backupPath = path.join(txDir, "backups", "app.txt");
  await fs.writeFile(stagedPath, "changed");
  await fs.writeFile(backupPath, "hello");
  if (options.removeBackup) await fs.rm(backupPath, { force: true });

  const originalHash = crypto.createHash("sha256").update("hello").digest("hex");
  const candidateHash = crypto.createHash("sha256").update("changed").digest("hex");

  const completed = options.completed ?? [];
  if (completed.includes("app.txt")) {
    await fs.writeFile(path.join(projectDir, "app.txt"), "changed");
  }
  if (options.mutateAfterApply) {
    await fs.writeFile(path.join(projectDir, "app.txt"), "externally-changed");
  }

  const record = {
    id: txId,
    state,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sourceProject: projectDir,
    sourceProjectIdentity: "test",
    operations: [{ type: "write", relativePath: "app.txt" }],
    files: [{
      relativePath: "app.txt",
      existed: true,
      originalHash,
      backupPath,
      stagedPath,
      candidateHash,
    }],
    completedOperations: completed,
    rollbackCompleted: [],
  };
  await fs.mkdir(path.join(tmp, "transactions"), { recursive: true });
  await fs.writeFile(path.join(tmp, "transactions", txId, "transaction.json"), JSON.stringify(record, null, 2));
  return { id: txId, projectDir };
}

describe("Transaction recovery", () => {
  it("rolls back a prepared transaction without source changes", async () => {
    const { id, projectDir } = await createTransaction("prepared", { completed: [] });
    const tm = new TransactionManager(tmp, null as any);
    const recovered = await tm.recover(id);
    expect(recovered.state).toBe("rolled_back");
    expect(await fs.readFile(path.join(projectDir, "app.txt"), "utf8")).toBe("hello");
  });

  it("restores original content after a completed write", async () => {
    const { id, projectDir } = await createTransaction("applying", { completed: ["app.txt"] });
    const tm = new TransactionManager(tmp, null as any);
    const recovered = await tm.recover(id);
    expect(recovered.state).toBe("rolled_back");
    expect(await fs.readFile(path.join(projectDir, "app.txt"), "utf8")).toBe("hello");
  });

  it("marks recovery_required when a backup is missing", async () => {
    const { id } = await createTransaction("applying", { completed: ["app.txt"], removeBackup: true });
    const tm = new TransactionManager(tmp, null as any);
    const recovered = await tm.recover(id);
    expect(recovered.state).toBe("recovery_required");
  });

  it("is idempotent for a rolled-back transaction", async () => {
    const { id } = await createTransaction("applying", { completed: ["app.txt"] });
    const tm = new TransactionManager(tmp, null as any);
    const first = await tm.recover(id);
    const second = await tm.recover(id);
    expect(first.state).toBe("rolled_back");
    expect(second.state).toBe("rolled_back");
  });

  it("does not overwrite unrelated changes during rollback", async () => {
    const { id, projectDir } = await createTransaction("applying", { completed: ["app.txt"], mutateAfterApply: true });
    const tm = new TransactionManager(tmp, null as any);
    const recovered = await tm.recover(id);
    expect(recovered.state).toBe("recovery_required");
    expect(await fs.readFile(path.join(projectDir, "app.txt"), "utf8")).toBe("externally-changed");
  });

  it("leaves a committed transaction committed", async () => {
    const { id } = await createTransaction("committed", { completed: ["app.txt"] });
    const tm = new TransactionManager(tmp, null as any);
    const recovered = await tm.recover(id);
    expect(recovered.state).toBe("committed");
  });
});