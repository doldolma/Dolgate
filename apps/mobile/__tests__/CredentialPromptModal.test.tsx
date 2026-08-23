import React from "react";
import renderer, { act } from "react-test-renderer";
import { TextInput } from "react-native";
import { CredentialPromptModal } from "../src/components/CredentialPromptModal";

jest.mock("react-native-vector-icons/Ionicons", () => "Ionicons");
// 팔레트가 스토어를 타고 들어와서 저장소·키체인까지 딸려 온다. 이 시험은 창 하나만 본다.
jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => null),
  removeItem: jest.fn(async () => null),
  clear: jest.fn(async () => null),
}));
jest.mock("react-native-keychain", () => ({
  ACCESSIBLE: {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: "WHEN_UNLOCKED_THIS_DEVICE_ONLY",
  },
  getGenericPassword: jest.fn(async () => null),
  setGenericPassword: jest.fn(async () => true),
  resetGenericPassword: jest.fn(async () => true),
}));
jest.mock("../src/lib/document-picker", () => ({
  documentPickerTypes: { plainText: "public.text", allFiles: "public.item" },
  pickLocalDocument: jest.fn(async () => null),
}));

function collectText(
  node: renderer.ReactTestRendererJSON | renderer.ReactTestRendererJSON[] | null,
): string[] {
  if (!node) {
    return [];
  }
  if (Array.isArray(node)) {
    return node.flatMap((child) => collectText(child));
  }
  const own = (node.children ?? []).flatMap((child) =>
    typeof child === "string" ? [child] : collectText(child),
  );
  return own;
}

function instanceText(node: renderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : instanceText(child)))
    .join("");
}

/** 누르는 것을 글자로 찾는다 — 버튼에 라벨이 없어서 순서로 집으면 문구가 바뀔 때 조용히 어긋난다. */
function findPressableByText(
  tree: renderer.ReactTestRenderer,
  label: string,
): renderer.ReactTestInstance {
  const match = tree.root.findAll(
    (node) =>
      typeof node.props.onPress === "function" &&
      instanceText(node).includes(label),
  );
  if (!match.length) {
    throw new Error(`pressable not found: ${label}`);
  }
  // 가장 안쪽(버튼 자체)을 쓴다. 바깥 컨테이너도 같은 글자를 품고 있다.
  return match[match.length - 1];
}

const request = {
  hostLabel: "가시리 RTU",
  authType: "password" as const,
  message: null,
  initialUsername: "ubuntu",
  initialValue: { password: "stale" },
};

describe("CredentialPromptModal", () => {
  it("붙기 전 창에서도 사용자명을 고칠 수 있다", async () => {
    // 붙기 전 창에 사용자명이 없으면, 사용자명이 틀렸을 때 눈앞에 자격증명 창을 두고도
    // 고칠 데가 없다 — 붙어 보고 실패할 때까지 기다려야 했다.
    const onSubmit = jest.fn();
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <CredentialPromptModal
          prompt={request}
          onSubmit={onSubmit}
          onCancel={jest.fn()}
        />,
      );
    });

    const inputs = tree!.root.findAllByType(TextInput);
    expect(inputs[0].props.value).toBe("ubuntu");
    // 붙기 전 창은 저장된 비밀을 채워 준다(지우고 다시 칠 수 있게).
    expect(inputs[1].props.value).toBe("stale");

    await act(async () => {
      inputs[0].props.onChangeText("admin");
    });
    await act(async () => {
      findPressableByText(tree!, "저장 후 연결").props.onPress();
    });

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ username: "admin", password: "stale" }),
    );

    await act(async () => {
      tree!.unmount();
    });
  });

  it("재시도 창은 사용자명을 채워 주고 비밀 칸은 비워 둔다", async () => {
    // 방금 실패한 비밀을 채워 두면 그대로 다시 보내기 쉽고, 무엇을 고쳐야 하는지도 가려진다.
    const onSubmit = jest.fn();
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <CredentialPromptModal
          prompt={request}
          variant="retry"
          onSubmit={onSubmit}
          onCancel={jest.fn()}
        />,
      );
    });

    const inputs = tree!.root.findAllByType(TextInput);
    expect(inputs[0].props.value).toBe("ubuntu");
    expect(inputs[1].props.value).toBe("");

    await act(async () => {
      inputs[0].props.onChangeText("admin");
      inputs[1].props.onChangeText("fresh");
    });

    const submitButton = findPressableByText(tree!, "다시 연결");
    await act(async () => {
      submitButton.props.onPress();
    });

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ username: "admin", password: "fresh" }),
    );

    await act(async () => {
      tree!.unmount();
    });
  });

  it("사용자명이 비면 제출하지 않는다", async () => {
    // 두 경우 모두 막는다 — 빈 사용자명으로 나가면 서버가 거절할 뿐이다.
    const onSubmit = jest.fn();
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <CredentialPromptModal
          prompt={{ ...request, initialUsername: "" }}
          variant="retry"
          onSubmit={onSubmit}
          onCancel={jest.fn()}
        />,
      );
    });

    const inputs = tree!.root.findAllByType(TextInput);
    await act(async () => {
      inputs[1].props.onChangeText("fresh");
    });
    const submitButton = findPressableByText(tree!, "다시 연결");
    await act(async () => {
      submitButton.props.onPress();
    });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(collectText(tree!.toJSON()).join(" ")).toContain(
      "사용자명을 입력해 주세요.",
    );

    await act(async () => {
      tree!.unmount();
    });
  });
});
