// 모듈 오버라이드는 shared-core 에 있다 — 모바일도 같은 제너레이터를 돌려야 결과가 같다.
export {
  applyCommandModuleOverrides,
  normalizeCommandModule,
  parseDockerContainerRows,
} from "@shared";
