import type { BuildInstruction } from "./types.js";

const KNOWN_INSTRUCTIONS = new Set([
  "FROM", "RUN", "CMD", "ENTRYPOINT", "WORKDIR", "COPY", "ADD", "ENV", "ARG",
  "EXPOSE", "LABEL", "USER", "VOLUME", "STOPSIGNAL", "HEALTHCHECK", "SHELL",
]);

export function parseJailfile(text: string): BuildInstruction[] {
  const logicalLines = toLogicalLines(text);
  const instructions: BuildInstruction[] = [];
  let seenFrom = false;
  let seenNonArg = false;

  for (let i = 0; i < logicalLines.length; i++) {
    const raw = logicalLines[i].trim();
    if (raw.length === 0) continue;
    if (raw.startsWith("#")) continue;

    const match = raw.match(/^([A-Za-z]+)\s*(.*)$/);
    if (!match) throw new Error(`invalid instruction at line ${i + 1}: ${raw}`);
    const type = match[1].toUpperCase();
    const args = match[2].trim();
    if (!KNOWN_INSTRUCTIONS.has(type)) {
      throw new Error(`unknown instruction "${type}" at line ${i + 1}`);
    }
    if (args.length === 0 && type !== "FROM") {
      // FROM requires an argument too; handled below uniformly.
    }
    if (args.length === 0) {
      throw new Error(`instruction "${type}" requires arguments at line ${i + 1}`);
    }

    if (type === "FROM") {
      seenFrom = true;
    } else if (type !== "ARG") {
      seenNonArg = true;
    }
    if (seenNonArg && !seenFrom) {
      throw new Error(`FROM must appear before "${type}" at line ${i + 1}`);
    }

    instructions.push({ type, args, raw, line: i + 1 });
  }

  if (!seenFrom) throw new Error("Jailfile must contain a FROM instruction");
  return instructions;
}

function toLogicalLines(text: string): string[] {
  const physical = text.split(/\r?\n/);
  const logical: string[] = [];
  let current = "";
  for (const line of physical) {
    if (current.length > 0) {
      current += "\n" + line;
    } else {
      current = line;
    }
    if (current.trimEnd().endsWith("\\")) {
      current = current.trimEnd().slice(0, -1);
      continue;
    }
    logical.push(current);
    current = "";
  }
  if (current.trim().length > 0) logical.push(current);
  return logical;
}

import fs from "node:fs";
import path from "node:path";

export function defaultJailfilePath(contextDir: string): string {
  const candidates = ["Jailfile", "Jailfile.json", "Dockerfile"];
  for (const name of candidates) {
    const full = path.join(contextDir, name);
    if (fs.existsSync(full)) return full;
  }
  return path.join(contextDir, "Jailfile");
}