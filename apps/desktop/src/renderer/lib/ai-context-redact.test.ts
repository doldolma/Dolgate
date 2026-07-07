import { describe, expect, it } from "vitest";
import { redactAiContext } from "./ai-context-redact";

describe("redactAiContext", () => {
  it("redacts OpenAI / Anthropic style keys", () => {
    expect(redactAiContext("export OPENAI_API_KEY=sk-abcdef1234567890")).not.toContain(
      "abcdef1234567890",
    );
    expect(redactAiContext("key sk-ant-api03-XYZ123456789")).toContain("sk-***");
  });

  it("redacts AWS access key ids and secret assignments", () => {
    const out = redactAiContext("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    const secret = redactAiContext("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY");
    expect(secret).not.toContain("wJalrXUtnFEMI");
    expect(secret).toContain("AWS_SECRET_ACCESS_KEY");
  });

  it("redacts GitHub / Google / Slack tokens", () => {
    expect(redactAiContext("token ghp_0123456789abcdefghijklmnopqrstuvwxyz")).toContain("ghp_***");
    expect(redactAiContext("AIzaSyA1234567890abcdefghijklmnopqrstuv")).toContain("AIza***");
    expect(redactAiContext("xoxb-1234567890-abcdefghij")).toContain("xox***");
  });

  it("redacts Bearer and x-api-key headers", () => {
    expect(redactAiContext("Authorization: Bearer eyJhbGciOiJIUzI1")).toContain("Bearer ***");
    expect(redactAiContext("x-api-key: super-secret-value")).not.toContain("super-secret-value");
  });

  it("redacts URL inline credentials but keeps the user", () => {
    const out = redactAiContext("git clone https://alice:hunter2@github.com/a/b.git");
    expect(out).toContain("alice:***@");
    expect(out).not.toContain("hunter2");
  });

  it("redacts quoted -p passwords and key=value secrets", () => {
    expect(redactAiContext("mysql -u root -p'S3cr3tPass'")).not.toContain("S3cr3tPass");
    const kv = redactAiContext('password = "letmein123"');
    expect(kv).not.toContain("letmein123");
    expect(kv.toLowerCase()).toContain("password");
  });

  it("redacts PEM private key blocks", () => {
    const pem =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\nAAAA\n-----END OPENSSH PRIVATE KEY-----";
    const out = redactAiContext(pem);
    expect(out).toBe("[REDACTED PRIVATE KEY]");
  });

  it("leaves ordinary terminal output untouched", () => {
    const normal = "total 24\ndrwxr-xr-x 3 user staff 96 Jul 7 10:00 src\nnpm test  # exit 0";
    expect(redactAiContext(normal)).toBe(normal);
  });

  it("returns empty input unchanged", () => {
    expect(redactAiContext("")).toBe("");
  });
});
