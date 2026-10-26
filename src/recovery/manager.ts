import crypto from "node:crypto";
import path from "node:path";
import { ExperimentManager } from "../experiments/manager.js";
import { LockManager } from "../coordination/lock-manager.js";
import { safeRelativePath, isPathInside, resolveInside } from "../security/paths.js";
import type { ExperimentCommandResult } from "../experiments/types.js";
import { SecretRedactor } from "../security/redactor.js";

export interface RepairProposal {
  summary: string;
  hypothesis: string;
  changes: Array<{ path: string; content: string }>;
  verificationCommand?: { command: string; args?: string[]; timeoutMs?: number };
  confidence?: number;
}

export interface RepairProvider {
  proposeRepair(context: Record<string, unknown>): Promise<RepairProposal>;
}

export class DeterministicRepairProvider implements RepairProvider {
  async proposeRepair(context: Record<string, unknown>): Promise<RepairProposal> {
    const failure = String(context.failure ?? "");
    if (/ENOENT|not found/i.test(failure)) {
      const match = failure.match(/open '([^']+)'/);
      const missingPath = match?.[1];
      if (missingPath) {
        const relative = missingPath.split(/[/\\]runtime[/\\]jails[/\\][^/\\]+[/\\]/).pop() ?? "missing.txt";
        return {
          summary: "Create the missing file referenced by the failure",
          hypothesis: "The command failed because a required file was absent",
          changes: [{ path: relative, content: "created by deterministic repair\n" }],
          verificationCommand: context.verificationCommand as any,
          confidence: 0.5,
        };
      }
    }
    return {
      summary: "No automated repair available",
      hypothesis: "The failure could not be classified into a safe automated repair",
      changes: [],
      verificationCommand: context.verificationCommand as any,
      confidence: 0,
    };
  }
}

export interface RecoveryResult {
  experimentId: string;
  attempts: number;
  succeeded: boolean;
  stoppedReason: string;
  attemptHistory: Array<Record<string, unknown>>;
}

export class RecoveryManager {
  private experimentManager: ExperimentManager;
  private provider: RepairProvider;
  private redactor: SecretRedactor;
  private lockManager: LockManager;

  constructor(experimentManager: ExperimentManager, provider?: RepairProvider, lockManager?: LockManager) {
    this.experimentManager = experimentManager;
    this.provider = provider ?? new DeterministicRepairProvider();
    this.redactor = new SecretRedactor();
    this.lockManager = lockManager ?? new LockManager(experimentManager.getBaseDir());
  }

  private async persist(experimentId: string, attempts: Array<Record<string, unknown>>): Promise<void> {
    await this.experimentManager.setRecoveryAttempts(experimentId, attempts);
  }

  private isPathSafe(rootDir: string, relativePath: string): boolean {
    return safeRelativePath(relativePath) !== null && resolveInside(rootDir, relativePath) !== null;
  }

  private validateProposal(proposal: unknown): RepairProposal {
    if (!proposal || typeof proposal !== "object") throw new Error("malformed repair proposal");
    const value = proposal as Record<string, unknown>;
    if (typeof value.summary !== "string") throw new Error("repair proposal is missing a summary");
    if (typeof value.hypothesis !== "string") throw new Error("repair proposal is missing a hypothesis");
    if (!Array.isArray(value.changes)) throw new Error("repair proposal changes must be an array");
    const changes = value.changes.map((change) => {
      if (!change || typeof change !== "object") throw new Error("malformed repair change");
      const item = change as Record<string, unknown>;
      if (typeof item.path !== "string" || typeof item.content !== "string") throw new Error("repair change must contain string path and content");
      if (!safeRelativePath(item.path)) throw new Error(`unsafe repair path: ${item.path}`);
      return { path: item.path, content: item.content };
    });
    return {
      summary: value.summary,
      hypothesis: value.hypothesis,
      changes,
      verificationCommand: value.verificationCommand as RepairProposal["verificationCommand"],
      confidence: typeof value.confidence === "number" ? value.confidence : undefined,
    };
  }

  async recover(experimentId: string, options: {
    maxAttempts?: number;
    timeoutMs?: number;
    verificationCommand?: { command: string; args?: string[]; timeoutMs?: number };
    cancelRequested?: () => boolean;
  } = {}): Promise<RecoveryResult> {
    return this.lockManager.withLock(`experiment:${experimentId}`, () => this._recover(experimentId, options), 10000);
  }

  private async _recover(experimentId: string, options: {
    maxAttempts?: number;
    timeoutMs?: number;
    verificationCommand?: { command: string; args?: string[]; timeoutMs?: number };
    cancelRequested?: () => boolean;
  } = {}): Promise<RecoveryResult> {
    const experiment = await this.experimentManager.inspect(experimentId);
    const attempts = [...(experiment.recoveryAttempts ?? [])];

    // Persisted recovery budgets cannot be reset by restarting Envia or by provider requests.
    let maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? 3, 10));
    let deadline = Date.now() + (options.timeoutMs ?? 60000);
    const existingBudget = experiment.recoveryBudget;
    if (existingBudget && new Date(existingBudget.deadlineAt).getTime() > Date.now()) {
      maxAttempts = Math.min(maxAttempts, existingBudget.maxAttempts);
      deadline = Math.min(deadline, new Date(existingBudget.deadlineAt).getTime());
    } else {
      await this.experimentManager.setRecoveryBudget(experimentId, {
        maxAttempts,
        deadlineAt: new Date(deadline).toISOString(),
        createdAt: new Date().toISOString(),
      }).catch(() => undefined);
    }

    let stoppedReason = "budget exhausted";
    let succeeded = false;

    const lastCommand = experiment.commands[experiment.commands.length - 1];
    const failureSignature = `${lastCommand?.exitCode ?? "none"}:${(lastCommand?.stderr ?? "").slice(0, 120)}`;

    while (attempts.length < maxAttempts && Date.now() < deadline) {
      if (options.cancelRequested?.()) {
        stoppedReason = "cancelled";
        break;
      }
      const attemptNumber = attempts.length + 1;
      const priorSignatures = attempts.map((a) => a.failureSignature);
      if (priorSignatures.filter((s) => s === failureSignature).length >= 2) {
        stoppedReason = "repeated failure detected";
        break;
      }

      const startedAt = new Date().toISOString();
      const context = {
        experimentId,
        status: experiment.status,
        lastCommand,
        failure: lastCommand?.stderr || lastCommand?.stdout || "unknown failure",
        hypothesis: experiment.hypothesis,
        verificationCommand: options.verificationCommand ?? (lastCommand ? { command: lastCommand.command, args: lastCommand.args, timeoutMs: lastCommand.timedOut ? 5000 : undefined } : undefined),
      };

      let proposal: RepairProposal;
      try {
        proposal = this.validateProposal(await Promise.race([
          this.provider.proposeRepair(context),
          new Promise((_, reject) => setTimeout(() => reject(new Error("repair provider timed out")), Math.max(1, deadline - Date.now()))),
        ]));
      } catch (err) {
        const attempt = {
          id: crypto.randomUUID(),
          experimentId,
          attempt: attemptNumber,
          classification: "provider-error",
          hypothesis: "Repair provider failed",
          appliedChanges: [],
          verificationExitCode: null,
          outcome: "failed",
          startedAt,
          endedAt: new Date().toISOString(),
          notes: this.redactor.redactText(String(err)),
          failureSignature,
        };
        attempts.push(attempt);
        await this.persist(experimentId, attempts);
        stoppedReason = "repair provider failed";
        break;
      }

      const appliedChanges: string[] = [];
      if (experiment.rootDir) {
        try {
          for (const change of proposal.changes) {
            if (!this.isPathSafe(experiment.rootDir, change.path)) {
              throw new Error(`unsafe repair path: ${change.path}`);
            }
            const target = resolveInside(experiment.rootDir, change.path);
            if (!target || !isPathInside(experiment.rootDir, target)) throw new Error(`unsafe repair path: ${change.path}`);
            await (await import("node:fs/promises")).mkdir(path.dirname(target), { recursive: true });
            await (await import("node:fs/promises")).writeFile(target, change.content);
            appliedChanges.push(change.path);
          }
        } catch (err) {
          const attempt = {
            id: crypto.randomUUID(),
            experimentId,
            attempt: attemptNumber,
            classification: "unsafe-repair",
            hypothesis: proposal.hypothesis,
            appliedChanges,
            verificationExitCode: null,
            outcome: "failed",
            startedAt,
            endedAt: new Date().toISOString(),
            notes: this.redactor.redactText(String(err)),
            failureSignature,
          };
          attempts.push(attempt);
          await this.persist(experimentId, attempts);
          stoppedReason = "repair application failed";
          break;
        }
      }

      const verification = proposal.verificationCommand ?? options.verificationCommand ?? (lastCommand ? { command: lastCommand.command, args: lastCommand.args } : undefined);
      let verificationExitCode: number | null = null;
      if (verification) {
        try {
          const result = await this.experimentManager.runCommand(experimentId, verification.command, verification.args ?? [], { timeoutMs: verification.timeoutMs });
          verificationExitCode = result.exitCode;
        } catch (err) {
          verificationExitCode = null;
        }
      }

      const outcome = verificationExitCode === 0 ? "succeeded" : "failed";
      if (outcome === "succeeded") succeeded = true;
      const attempt = {
        id: crypto.randomUUID(),
        experimentId,
        attempt: attemptNumber,
        classification: this.classify(lastCommand),
        hypothesis: proposal.hypothesis,
        appliedChanges,
        verificationExitCode,
        outcome,
        startedAt,
        endedAt: new Date().toISOString(),
        notes: this.redactor.redactText(proposal.summary),
        failureSignature,
      };
      attempts.push(attempt);
      await this.persist(experimentId, attempts);

      if (succeeded) {
        stoppedReason = "verification passed";
        await this.experimentManager.complete(experimentId, `Recovered after ${attemptNumber} attempt(s)`).catch(() => undefined);
        break;
      }
      if (options.cancelRequested?.()) {
        stoppedReason = "cancelled";
        break;
      }
    }

    if (!succeeded && stoppedReason === "budget exhausted" && attempts.length >= maxAttempts) {
      stoppedReason = "maximum attempts reached";
    }

    await this.experimentManager.setRecoveryAttempts(experimentId, attempts).catch(() => undefined);

    return {
      experimentId,
      attempts: attempts.length,
      succeeded,
      stoppedReason,
      attemptHistory: attempts,
    };
  }

  private classify(command: ExperimentCommandResult | undefined): string {
    if (!command) return "unknown";
    if (command.timedOut) return "timeout";
    if (command.exitCode !== 0) {
      const output = `${command.stdout}\n${command.stderr}`;
      if (/ENOENT|not found|cannot find/i.test(output)) return "missing-dependency-or-file";
      if (/assert|test fail|FAIL/i.test(output)) return "test-failure";
      return "command-failure";
    }
    return "unknown";
  }
}