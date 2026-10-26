import { describe, it, expect } from "vitest";
import { SecretRedactor } from "../src/security/redactor.js";

describe("Secret redaction", () => {
  it("redacts common secrets", () => {
    const redactor = new SecretRedactor();
    const input = "token=supersecrettoken123\nBearer abcdefghijklmnop\n-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\nurl=https://user:pass@example.com/path";
    const output = redactor.redactText(input);
    expect(output).not.toContain("supersecrettoken123");
    expect(output).not.toContain("pass@example");
    expect(output).toContain("[REDACTED");
  });

  it("redacts sensitive env", () => {
    const redactor = new SecretRedactor();
    const env = redactor.redactEnv({ API_KEY: "abc", NORMAL: "value" });
    expect(env.API_KEY).toBe("[REDACTED]");
    expect(env.NORMAL).toBe("value");
  });
});