import { afterEach, describe, expect, it } from "vitest";
import {
  __resetDynamicCodexModelsForTest,
  CODEX_DEFAULT_MODEL,
  isAllowedCodexModel,
  normalizeCodexModel,
  rememberCodexModels,
} from "./codex-models";

describe("codex model allowlist", () => {
  afterEach(() => {
    __resetDynamicCodexModelsForTest();
  });

  it("accepts the static allowlist and coerces unknown models to the default (auto)", () => {
    expect(isAllowedCodexModel("gpt-5.6-sol")).toBe(true);
    expect(isAllowedCodexModel("auto")).toBe(true);
    expect(isAllowedCodexModel("gpt-5.3-codex-spark")).toBe(false);
    expect(normalizeCodexModel("gpt-5.3-codex-spark")).toBe(CODEX_DEFAULT_MODEL);
    expect(normalizeCodexModel(undefined)).toBe(CODEX_DEFAULT_MODEL);
  });

  it("accepts models learned from model/list at runtime (dynamic list selections)", () => {
    expect(isAllowedCodexModel("gpt-5.7-nova")).toBe(false);
    rememberCodexModels(["gpt-5.7-nova", " ", ""]);
    expect(isAllowedCodexModel("gpt-5.7-nova")).toBe(true);
    expect(normalizeCodexModel("gpt-5.7-nova")).toBe("gpt-5.7-nova");
  });
});
