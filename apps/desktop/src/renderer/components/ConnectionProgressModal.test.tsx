import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ConnectionView, PendingInteractiveAuth } from "../store/types";

// 이 컴포넌트는 스토어를 직접 읽는다(여러 화면에서 열리므로 props 로 뚫으면 경로마다 빠뜨린다).
// 테스트는 그 스토어만 세워 준다 — 다른 컴포넌트 테스트들과 같은 방식이다.
const storeState: Record<string, unknown> = {
  connectionViews: {},
  pendingInteractiveAuths: [],
  pendingHostKeyPrompt: null,
  tailnetStatuses: {},
};

vi.mock("../store/appStore", () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector(storeState),
}));

import { ConnectionProgressModal } from "./ConnectionProgressModal";

function seed(
  views: Record<string, ConnectionView>,
  auths: PendingInteractiveAuth[] = [],
) {
  storeState.connectionViews = views;
  storeState.pendingInteractiveAuths = auths;
  storeState.pendingHostKeyPrompt = null;
}

const connectingView: ConnectionView = {
  key: "rule-1",
  status: "connecting",
  hops: [
    { index: 1, count: 2, label: "ubuntu@bastion:22", stage: "connected" },
    { index: 2, count: 2, label: "ubuntu@target:22", stage: "connecting" },
  ],
};

describe("ConnectionProgressModal", () => {
  beforeEach(() => {
    seed({});
  });

  it("진행 중이면 홉을 보여준다", () => {
    seed({ "rule-1": connectingView });

    render(
      <ConnectionProgressModal
        connectionKey="rule-1"
        title="test-tunnel"
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("ubuntu@target:22")).toBeTruthy();
  });

  // 물음이 뜬 순간부터 사용자가 할 일은 **답하는 것**이다. 팝업을 그대로 두면 입력창을 덮어서
  // 답을 넣을 수 없다 — 실기기에서 그렇게 막혔다.
  it("사용자에게 묻는 중이면 내려간다", () => {
    seed({ "rule-1": connectingView }, [
      {
        source: "portForward",
        endpointId: "rule-1",
        ruleId: "rule-1",
        hostId: "host-1",
        challengeId: "rule-1-1",
        name: null,
        instruction: "",
        prompts: [{ label: "Verification code:", echo: false }],
        provider: "generic",
        autoSubmitted: false,
      } as never,
    ]);

    const { container } = render(
      <ConnectionProgressModal
        connectionKey="rule-1"
        title="test-tunnel"
        onClose={() => {}}
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  // 다른 연결이 묻는 중이라고 이 팝업까지 내려가면, 자기 진행 상황을 볼 수 없다.
  it("남의 물음에는 내려가지 않는다", () => {
    seed({ "rule-1": connectingView }, [
      {
        source: "portForward",
        endpointId: "rule-2",
        ruleId: "rule-2",
        hostId: "host-2",
        challengeId: "rule-2-1",
        name: null,
        instruction: "",
        prompts: [{ label: "Verification code:", echo: false }],
        provider: "generic",
        autoSubmitted: false,
      } as never,
    ]);

    render(
      <ConnectionProgressModal
        connectionKey="rule-1"
        title="test-tunnel"
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("ubuntu@target:22")).toBeTruthy();
  });

  it("뷰가 없으면 아무것도 그리지 않는다", () => {
    const { container } = render(
      <ConnectionProgressModal
        connectionKey="rule-1"
        title="test-tunnel"
        onClose={() => {}}
      />,
    );

    expect(container.firstChild).toBeNull();
  });
});
