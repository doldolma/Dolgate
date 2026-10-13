// Codex(ChatGPT 계정) 모델 목록. 근거는 codex-sdk 번들 바이너리의 `model/list` 응답
// (0.162.1 기준: gpt-6.1-sol[기본], gpt-6-astra, gpt-6-sol, gpt-6-luna, gpt-5.6-sol/terra/luna,
// gpt-5.5 — gpt-5.4·gpt-5.4-mini·gpt-5.3-codex-spark 는 목록에서 빠졌다). 채팅 시 판정은
// model/list 가 우선이고(ai-service.resolveCodexModel), 이 정적 목록은 목록을 못 받았을 때의 폴백이다.
// "auto" 는 모델을 지정하지 않고 codex 가 권장 모델을 고르게 하는 앱 레벨 센티널이다
// (provider-codex 가 startThread 에서 model 을 생략) — 기본값으로 두면 codex 쪽 권장
// 모델이 바뀌어도 앱 업데이트 없이 따라간다.
export const CODEX_AUTO_MODEL = "auto";

export const CODEX_DEFAULT_MODEL = CODEX_AUTO_MODEL;

const CODEX_ALLOWED_MODEL_IDS = new Set([
  CODEX_AUTO_MODEL,
  "gpt-6.1-sol",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
]);

// 런타임에 model/list 로 실제 확인된 모델 id(세션 캐시). 설정 UI 가 동적 목록에서 고른
// 모델이 정적 allowlist 에 없어도(예: 새 SDK 의 신규 모델) main 검증을 통과해야 하므로
// 합집합으로 판정한다. 캐시는 ai-service.codexListModels 가 조회 성공 시 채운다.
const dynamicCodexModelIds = new Set<string>();

export function rememberCodexModels(ids: Iterable<string>): void {
  for (const id of ids) {
    const trimmed = id.trim();
    if (trimmed) {
      dynamicCodexModelIds.add(trimmed);
    }
  }
}

// 이번 세션에 model/list 결과를 한 번이라도 받았는지 — 받았다면 동적 목록이 실제 카탈로그다.
export function hasLearnedCodexModels(): boolean {
  return dynamicCodexModelIds.size > 0;
}

export function __resetDynamicCodexModelsForTest(): void {
  dynamicCodexModelIds.clear();
}

export function isAllowedCodexModel(model: string): boolean {
  const trimmed = model.trim();
  return CODEX_ALLOWED_MODEL_IDS.has(trimmed) || dynamicCodexModelIds.has(trimmed);
}

export function normalizeCodexModel(model: string | null | undefined): string {
  const trimmed = model?.trim() ?? "";
  return trimmed && isAllowedCodexModel(trimmed) ? trimmed : CODEX_DEFAULT_MODEL;
}
