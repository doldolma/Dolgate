import type { ConnectionProgressStage } from "@shared";

export function formatConnectionProgressStageLabel(
  stage?: ConnectionProgressStage,
): string {
  switch (stage) {
    case "loading-instance-metadata":
      return "SSH 설정 확인";
    case "checking-profile":
      return "AWS 프로필 확인";
    case "browser-login":
      return "브라우저 로그인";
    case "checking-ssm":
      return "SSM 상태 확인";
    case "probing-host-key":
      return "호스트 키 확인";
    case "generating-key":
      return "임시 키 생성";
    case "sending-public-key":
      return "공개 키 전송";
    case "opening-tunnel":
      return "내부 터널 연결";
    case "connecting-sftp":
      return "SFTP 연결";
    case "connecting-containers":
      return "컨테이너 연결";
    case "loading-ecs-cluster":
      return "ECS 클러스터 조회";
    case "loading-ecs-metrics":
      return "사용량 지표 조회";
    default:
      return "연결 준비";
  }
}
