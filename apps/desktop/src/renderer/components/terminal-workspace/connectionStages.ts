// 연결 단계는 shared-core 가 계산한다 — 모바일도 같은 화면을 보여줘야 하고, tailnet 계층의 판정에는
// 쉽게 얻은 것이 아닌 규칙들이 들어 있어서 두 벌로 두면 한쪽만 고쳐진다.
//
// 이 파일에 남은 것은 데스크톱의 것뿐이다: 탭을 단계 입력으로 옮기는 일, 그리고 shared-core 가
// 돌려준 i18n 키를 이 앱의 문구로 바꾸는 일(그 패키지는 UI 언어를 결정할 수 없다).

import { resolveConnectionStages } from "@shared";
import type {
  ConnectionStage,
  ConnectionStageDetailPart,
  ConnectionStageSubject,
  TerminalTab,
} from "@shared";
import { t } from "../../i18n";

export {
  resolveConnectionStages,
  resolveConnectionTransport,
  resolveTailscaleStages,
} from "@shared";
export type {
  ConnectionFailureLayer,
  ConnectionStage,
  ConnectionStageDetailPart,
  ConnectionStageState,
  ConnectionStageSubject,
  ConnectionStageText,
  ConnectionTransport,
} from "@shared";

/** 터미널 탭을 단계 입력으로 옮긴다. 탭이 없으면 undefined 그대로 흘린다. */
export function stageSubjectFromTab(
  tab: TerminalTab | undefined,
): ConnectionStageSubject | undefined {
  if (!tab) {
    return undefined;
  }
  return {
    status: tab.status,
    stage: tab.connectionProgress?.stage,
    paneKind: tab.paneKind,
    source: tab.source,
  };
}

/** 조각 하나를 문구로. `text` 는 서버·백엔드가 준 원문이라 그대로 쓴다. */
function describePart(part: ConnectionStageDetailPart): string {
  return "text" in part ? part.text : t(part.key, part.params);
}

/**
 * 단계를 화면에 쓸 문구로 바꾼다.
 *
 * 조각을 ' · ' 로 잇는다. 번역된 안내와 백엔드 원문이 한 줄에 함께 오는 경우가 있어서(로그인 거부
 * 이유, 주고받은 양) 그것을 한 문장으로 합치면 원문이 어디부터인지 알 수 없다.
 */
export function describeConnectionStage(stage: ConnectionStage): {
  label: string;
  detail?: string;
} {
  const detail = stage.detail?.map(describePart).filter(Boolean).join(" · ");
  return {
    label: t(stage.label.key, stage.label.params),
    detail: detail || undefined,
  };
}
