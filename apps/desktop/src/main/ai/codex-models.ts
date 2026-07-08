export const CODEX_DEFAULT_MODEL = "gpt-5.5";

const CODEX_ALLOWED_MODEL_IDS = new Set([
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
]);

export function isAllowedCodexModel(model: string): boolean {
  return CODEX_ALLOWED_MODEL_IDS.has(model.trim());
}

export function normalizeCodexModel(model: string | null | undefined): string {
  const trimmed = model?.trim() ?? "";
  return trimmed && isAllowedCodexModel(trimmed) ? trimmed : CODEX_DEFAULT_MODEL;
}
