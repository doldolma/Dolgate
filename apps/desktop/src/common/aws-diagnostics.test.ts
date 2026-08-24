import { describe, expect, it } from "vitest";
import {
  AWS_SFTP_DIAGNOSTIC_REASON_CODES,
  inferAwsSftpDiagnosticReasonCode,
} from "@shared";
import {
  getAwsSftpDiagnosticAction,
  getAwsSftpDiagnosticMessage,
  getAwsSftpDiagnosticTitle,
} from "./aws-diagnostics";

// AWS 가 권한을 거부할 때 실제로 보내는 문장. 액션 이름이 여기 들어 있다.
const denied = (action: string) =>
  `User: arn:aws:sts::123456789012:assumed-role/DevRole/dolma is not authorized to perform: ${action} on resource: arn:aws:ec2:ap-northeast-2:123456789012:instance/i-0abc because no identity-based policy allows the ${action} action`;

describe("AWS 진단 원인 코드", () => {
  it("거부된 액션 이름으로 권한 실패를 가른다", () => {
    expect(
      inferAwsSftpDiagnosticReasonCode(
        "opening-tunnel",
        denied("ssm:StartSession"),
      ),
    ).toBe("ssm-access-denied");
    expect(
      inferAwsSftpDiagnosticReasonCode(
        "checking-ssm",
        denied("ssm:DescribeInstanceInformation"),
      ),
    ).toBe("describe-access-denied");
    expect(
      inferAwsSftpDiagnosticReasonCode(
        "sending-public-key",
        denied("ec2-instance-connect:SendSSHPublicKey"),
      ),
    ).toBe("eic-access-denied");
  });

  // 단계보다 문장에 적힌 액션을 먼저 믿는다 — 한 단계에서 여러 액션을 부르므로 단계만으로
  // 고르면 엉뚱한 액션을 짚어 준다.
  it("단계와 액션이 어긋나면 액션을 따른다", () => {
    expect(
      inferAwsSftpDiagnosticReasonCode(
        "checking-ssm",
        denied("ssm:StartSession"),
      ),
    ).toBe("ssm-access-denied");
  });

  it("액션을 알 수 없는 거부도 권한 문제로 말한다", () => {
    expect(
      inferAwsSftpDiagnosticReasonCode(
        "loading-instance-metadata",
        "AccessDeniedException: 요청이 거부되었습니다.",
      ),
    ).toBe("access-denied");
  });

  // 이것이 예전 동작이었다 — 권한이 없는 것이 확실한데 "확인되지 않은 오류" 로 뭉개졌다.
  it("권한 거부를 unknown 으로 떨어뜨리지 않는다", () => {
    for (const stage of [
      "checking-profile",
      "checking-ssm",
      "loading-instance-metadata",
      "opening-tunnel",
      "connecting-sftp",
    ] as const) {
      expect(
        inferAwsSftpDiagnosticReasonCode(stage, denied("ec2:DescribeInstances")),
      ).not.toBe("unknown");
    }
  });

  // 제한 시간 초과 안내에도 "권한을 확인한 뒤" 가 들어 있다. 그것까지 권한 문제로 단정하면
  // 되지도 않을 정책 수정을 시키게 된다.
  it("권한을 확인하라는 제한 시간 안내는 권한 문제로 보지 않는다", () => {
    expect(
      inferAwsSftpDiagnosticReasonCode(
        "checking-ssm",
        "SSM 상태 조회가 제한 시간을 초과했습니다. SSM 연결 상태와 권한을 확인한 뒤 다시 시도해 주세요.",
      ),
    ).toBe("unknown");
  });
});

describe("AWS 진단 문구 카탈로그", () => {
  // 코드를 추가하고 사전을 잊으면 화면에 i18n 키가 그대로 뜬다.
  it("모든 원인 코드에 제목·설명·조치가 있다", () => {
    for (const reasonCode of AWS_SFTP_DIAGNOSTIC_REASON_CODES) {
      for (const text of [
        getAwsSftpDiagnosticTitle(reasonCode),
        getAwsSftpDiagnosticMessage(reasonCode),
        getAwsSftpDiagnosticAction(reasonCode),
      ]) {
        expect(text).toBeTruthy();
        expect(text).not.toContain("awsDiagnostic.");
      }
    }
  });

  it("권한 부족 안내는 고칠 액션 이름을 말해 준다", () => {
    expect(getAwsSftpDiagnosticAction("ssm-access-denied")).toContain(
      "ssm:StartSession",
    );
    expect(getAwsSftpDiagnosticAction("describe-access-denied")).toContain(
      "ssm:DescribeInstanceInformation",
    );
  });
});
