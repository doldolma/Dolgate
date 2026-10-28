import React from "react";
import renderer, { act } from "react-test-renderer";
import { ActivityIndicator, Text, TextInput } from "react-native";
import { AwsKeyModal } from "../src/components/AwsKeyModal";

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

// 팀 정적 AWS 프로필에 이 기기의 키를 넣는 창(작업 8-4b) — 데스크톱 AwsKeyDialog 와 같은 자리·같은 말.
const REQUEST = { profileName: "acme-static", teamName: "Acme Infra" };

function texts(tree: renderer.ReactTestRenderer): string[] {
  return tree.root
    .findAllByType(Text)
    .map((node) => ([] as unknown[]).concat(node.props.children).join(""));
}

function field(tree: renderer.ReactTestRenderer, label: string) {
  return tree.root.findByProps({ accessibilityLabel: label });
}

function button(tree: renderer.ReactTestRenderer, label: string) {
  return tree.root.find(
    (node) =>
      node.props.accessibilityRole === "button" &&
      node.findAllByType(Text).some((text) => text.props.children === label),
  );
}

describe("AwsKeyModal", () => {
  it("shows the team profile and saves only when both keys are filled", async () => {
    const onSave = jest.fn(async () => undefined);
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <AwsKeyModal request={REQUEST} onCancel={jest.fn()} onSave={onSave} />,
      );
    });

    expect(texts(tree)).toEqual(
      expect.arrayContaining(["acme-static · 키", "Acme Infra", "Access Key", "Secret"]),
    );
    expect(field(tree, "Secret").findByType(TextInput).props.secureTextEntry).toBe(true);
    const save = () => button(tree, "저장 후 연결");
    expect(save().props.disabled).toBe(true);

    await act(async () => {
      field(tree, "Access Key").props.onChangeText("AKIAMINE");
    });
    expect(save().props.disabled).toBe(true);
    await act(async () => {
      field(tree, "Secret").props.onChangeText("mine-secret");
    });
    expect(save().props.disabled).toBe(false);

    await act(async () => {
      save().props.onPress();
    });
    expect(onSave).toHaveBeenCalledWith({
      accessKeyId: "AKIAMINE",
      secretAccessKey: "mine-secret",
    });
  });

  it("stays open with the reason when the key is rejected, and is busy while checking", async () => {
    let reject!: (error: Error) => void;
    const onSave = jest.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <AwsKeyModal request={REQUEST} onCancel={jest.fn()} onSave={onSave} />,
      );
    });
    await act(async () => {
      field(tree, "Access Key").props.onChangeText("AKIAWRONG");
      field(tree, "Secret").props.onChangeText("wrong");
    });
    await act(async () => {
      button(tree, "저장 후 연결").props.onPress();
    });

    // 확인하는 동안은 다시 누르거나 닫지 못한다.
    expect(tree.root.findAllByType(ActivityIndicator)).toHaveLength(1);
    expect(button(tree, "취소").props.disabled).toBe(true);

    await act(async () => {
      reject(new Error("AWS 자격 증명을 검증하지 못했습니다."));
    });
    expect(texts(tree)).toContain("AWS 자격 증명을 검증하지 못했습니다.");
    expect(tree.root.findAllByType(ActivityIndicator)).toHaveLength(0);
    // 넣은 값은 그대로 두어 고쳐 다시 넣게 한다.
    expect(field(tree, "Access Key").props.value).toBe("AKIAWRONG");
  });

  it("starts empty for another profile and closes on cancel", async () => {
    const onCancel = jest.fn();
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <AwsKeyModal request={REQUEST} onCancel={onCancel} onSave={jest.fn()} />,
      );
    });
    await act(async () => {
      field(tree, "Access Key").props.onChangeText("AKIAMINE");
    });
    await act(async () => {
      tree.update(
        <AwsKeyModal
          request={{ profileName: "acme-dev", teamName: "Acme Infra" }}
          onCancel={onCancel}
          onSave={jest.fn()}
        />,
      );
    });
    expect(field(tree, "Access Key").props.value).toBe("");

    await act(async () => {
      button(tree, "취소").props.onPress();
    });
    expect(onCancel).toHaveBeenCalled();
  });
});
