import { describe, expect, it } from "vitest";
import {
  hasSnippetVariables,
  parseSnippetVariables,
  resolveSnippetCommand,
} from "./snippet";

describe("parseSnippetVariables", () => {
  it("returns [] when there are no variables", () => {
    expect(parseSnippetVariables("ls -la")).toEqual([]);
  });

  it("extracts variables in order, de-duplicated", () => {
    expect(
      parseSnippetVariables("deploy {{svc}} to {{env}} (re-check {{svc}})"),
    ).toEqual([
      { name: "svc", defaultValue: "" },
      { name: "env", defaultValue: "" },
    ]);
  });

  it("captures default values and trims them", () => {
    expect(parseSnippetVariables("kubectl -n {{ns= default }} get pods")).toEqual([
      { name: "ns", defaultValue: "default" },
    ]);
  });

  it("adopts a default from any occurrence of the same variable", () => {
    expect(parseSnippetVariables("{{x}} then {{x=foo}}")).toEqual([
      { name: "x", defaultValue: "foo" },
    ]);
  });
});

describe("hasSnippetVariables", () => {
  it("detects presence/absence", () => {
    expect(hasSnippetVariables("echo {{x}}")).toBe(true);
    expect(hasSnippetVariables("echo hi")).toBe(false);
  });

  it("is repeatable (no global-regex lastIndex leak)", () => {
    expect(hasSnippetVariables("echo {{x}}")).toBe(true);
    expect(hasSnippetVariables("echo {{x}}")).toBe(true);
  });
});

describe("resolveSnippetCommand", () => {
  it("substitutes provided values", () => {
    expect(
      resolveSnippetCommand("deploy {{svc}} to {{env}}", {
        svc: "web",
        env: "prod",
      }),
    ).toBe("deploy web to prod");
  });

  it("falls back to the default when a value is missing", () => {
    expect(resolveSnippetCommand("kubectl -n {{ns=default}} get", {})).toBe(
      "kubectl -n default get",
    );
  });

  it("uses an empty string when there is no value and no default", () => {
    expect(resolveSnippetCommand("echo {{x}}", {})).toBe("echo ");
  });

  it("prefers a provided value over the default", () => {
    expect(resolveSnippetCommand("-n {{ns=default}}", { ns: "kube-system" })).toBe(
      "-n kube-system",
    );
  });

  it("replaces repeated occurrences", () => {
    expect(resolveSnippetCommand("{{x}}-{{x}}", { x: "a" })).toBe("a-a");
  });
});
