import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface RedactionRule {
  name: string;
  pattern: string;
  replacement?: string;
}

export interface RedactionConfig {
  enabled: boolean;
  rules: RedactionRule[];
  sensitiveNames: string[];
}

export const DEFAULT_REDACTION_CONFIG: RedactionConfig = {
  enabled: true,
  rules: [
    { name: "private-key", pattern: "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----", replacement: "[REDACTED:private-key]" },
    { name: "bearer-token", pattern: "\\bBearer\\s+[A-Za-z0-9._~+/=-]{10,}", replacement: "Bearer [REDACTED]" },
    { name: "basic-auth", pattern: "\\bBasic\\s+[A-Za-z0-9+/=]{10,}", replacement: "Basic [REDACTED]" },
    { name: "url-credentials", pattern: "([a-zA-Z][a-zA-Z0-9+.-]*://)([^/\\s:@]+):([^/\\s@]+)@", replacement: "$1[REDACTED]:[REDACTED]@" },
    { name: "aws-access-key", pattern: "\\bAKIA[0-9A-Z]{16}\\b", replacement: "[REDACTED:aws-access-key]" },
    { name: "github-token", pattern: "\\bgh[pousr]_[A-Za-z0-9]{36,}\\b", replacement: "[REDACTED:github-token]" },
    { name: "slack-token", pattern: "\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b", replacement: "[REDACTED:slack-token]" },
    { name: "google-api-key", pattern: "\\bAIza[0-9A-Za-z_-]{35}\\b", replacement: "[REDACTED:google-api-key]" },
    { name: "jwt", pattern: "\\beyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\b", replacement: "[REDACTED:jwt]" },
    { name: "secret-assignment", pattern: "\\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)[A-Za-z0-9_]*)\\s*[:=]\\s*['\"]?[^'\"\\s]{4,}", replacement: "$1=[REDACTED]" },
    { name: "connection-string", pattern: "\\b(postgres|postgresql|mysql|mongodb|redis)://[^\\s]*", replacement: "[REDACTED:connection-string]" },
  ],
  sensitiveNames: ["API_KEY", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN", "DATABASE_URL", "POSTGRES_PASSWORD", "MYSQL_PASSWORD", "REDIS_PASSWORD", "PRIVATE_KEY", "CLIENT_SECRET", "ACCESS_TOKEN", "REFRESH_TOKEN", "JWT_SECRET"],
};

const REDACTION_MARKER = "[REDACTED]";

export class SecretRedactor {
  private config: RedactionConfig;
  private compiled: Array<{ name: string; regex: RegExp; replacement: string }>;

  constructor(config: RedactionConfig = DEFAULT_REDACTION_CONFIG) {
    this.config = config;
    this.compiled = this.compile(config);
  }

  private compile(config: RedactionConfig): Array<{ name: string; regex: RegExp; replacement: string }> {
    const compiled: Array<{ name: string; regex: RegExp; replacement: string }> = [];
    if (!config.enabled) return compiled;
    for (const rule of config.rules) {
      try {
        compiled.push({ name: rule.name, regex: new RegExp(rule.pattern, "gi"), replacement: rule.replacement ?? REDACTION_MARKER });
      } catch {
        // Invalid user patterns are ignored rather than crashing the redactor.
      }
    }
    return compiled;
  }

  redactText(input: string): string {
    if (!this.config.enabled) return input;
    if (typeof input !== "string") return input;
    try {
      let output = input;
      for (const rule of this.compiled) {
        output = output.replace(rule.regex, rule.replacement);
      }
      // Redact environment-style assignments for configured sensitive names.
      for (const name of this.config.sensitiveNames) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(`\\b${escaped}\\s*[:=]\\s*['\"]?[^'\"\\s]{1,}`, "gi");
        output = output.replace(regex, `${name}=[REDACTED]`);
      }
      return output;
    } catch {
      return "[REDACTED: redaction failure]";
    }
  }

  redactError(error: unknown): string {
    if (error instanceof Error) {
      return this.redactText(`${error.name}: ${error.message}\n${error.stack ?? ""}`).trim();
    }
    return this.redactText(String(error));
  }

  redactArgs(args: string[]): string[] {
    return args.map((arg) => this.redactText(arg));
  }

  redactEnv(env: Record<string, string>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      const upper = key.toUpperCase();
      const sensitive = this.config.sensitiveNames.includes(upper) ||
        /(SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|AUTHORIZATION)/.test(upper);
      result[key] = sensitive ? "[REDACTED]" : this.redactText(value);
    }
    return result;
  }

  redactObject(value: unknown, depth = 0): unknown {
    if (depth > 8) return "[REDACTED: depth limit]";
    if (typeof value === "string") return this.redactText(value);
    if (Array.isArray(value)) return value.map((item) => this.redactObject(item, depth + 1));
    if (value && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        const upper = key.toUpperCase();
        const sensitive = this.config.sensitiveNames.includes(upper) ||
          /(SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|AUTHORIZATION)/.test(upper);
        result[key] = sensitive ? "[REDACTED]" : this.redactObject(val, depth + 1);
      }
      return result;
    }
    return value;
  }
}

export class RedactionConfigManager {
  private configPath: string;

  constructor(baseDir: string) {
    this.configPath = path.join(baseDir, "redaction.json");
  }

  async load(): Promise<RedactionConfig> {
    if (!existsSync(this.configPath)) return DEFAULT_REDACTION_CONFIG;
    try {
      const raw = await readFile(this.configPath, "utf8");
      const parsed = JSON.parse(raw) as RedactionConfig;
      return { ...DEFAULT_REDACTION_CONFIG, ...parsed };
    } catch {
      return DEFAULT_REDACTION_CONFIG;
    }
  }

  async save(config: RedactionConfig): Promise<void> {
    await mkdir(path.dirname(this.configPath), { recursive: true });
    await writeFile(this.configPath, JSON.stringify(config, null, 2));
  }
}