import React from "react";
import renderer, { act } from "react-test-renderer";
import { Pressable, Text } from "react-native";
import { Swipeable } from "react-native-gesture-handler";
import {
  closeOpenSwipeableRow,
  SwipeableRow,
} from "../src/components/SwipeableRow";

// 밀어서 나오는 액션. 목록에서 잘못 누르면 되돌릴 수 없는 것(삭제)이 들어 있어서, 무엇이
// 어떤 순서로 불리는지 여기서 잠근다.

function actions(onEdit: () => void, onDelete: () => void) {
  return [
    {
      key: "edit",
      label: "수정",
      icon: "pencil-outline",
      background: "#636366",
      onPress: onEdit,
    },
    {
      key: "delete",
      label: "삭제",
      icon: "trash-outline",
      background: "#FF453A",
      onPress: onDelete,
    },
  ];
}

type ActionElement = { props: { accessibilityLabel: string; onPress: () => void } };

function findSwipeable(tree: renderer.ReactTestRenderer) {
  return tree.root.findByType(Swipeable);
}

describe("SwipeableRow", () => {
  it("줄 내용과 액션을 함께 들고 있다", async () => {
    // Swipeable 은 액션을 미리 그려 두고 화면 밖에 둔다(밀면 그 자리로 들어온다). 그래서
    // 트리에는 처음부터 있다 — 이 사실을 모르면 "전체에서 라벨로 찾기" 하는 테스트가 시트를
    // 안 눌러도 통과한다.
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <SwipeableRow actions={actions(jest.fn(), jest.fn())}>
          <Text>web-prod-01</Text>
        </SwipeableRow>,
      );
    });

    expect(
      tree!.root.findAllByType(Text).some(n => n.props.children === "web-prod-01"),
    ).toBe(true);
    expect(findSwipeable(tree!).props.renderRightActions).toBeInstanceOf(Function);
  });

  it("액션은 오른쪽 끝에서부터 놓이고, 삭제가 가장 바깥이다", async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <SwipeableRow actions={actions(jest.fn(), jest.fn())}>
          <Text>web-prod-01</Text>
        </SwipeableRow>,
      );
    });

    const rendered = findSwipeable(tree!).props.renderRightActions();
    const labels = (rendered.props.children as ActionElement[]).map(
      child => child.props.accessibilityLabel,
    );
    // 엄지가 먼저 닿는 자리가 수정이다. 삭제를 한 칸 더 가게 두는 것이 잘못 누름을 줄인다.
    expect(labels).toEqual(["수정", "삭제"]);
  });

  it("액션을 누르면 줄을 닫고 나서 실행한다", async () => {
    const order: string[] = [];
    const onDelete = jest.fn(() => order.push("delete"));
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <SwipeableRow actions={actions(jest.fn(), onDelete)}>
          <Text>web-prod-01</Text>
        </SwipeableRow>,
      );
    });

    const swipeable = findSwipeable(tree!);
    const closeSpy = jest
      .spyOn(swipeable.instance as unknown as { close: () => void }, "close")
      .mockImplementation(() => order.push("close"));

    const rendered = swipeable.props.renderRightActions();
    const deleteAction = (rendered.props.children as ActionElement[]).find(
      child => child.props.accessibilityLabel === "삭제",
    )!;

    await act(async () => {
      deleteAction.props.onPress();
    });

    // 확인창이 열린 줄 위로 올라오면, 돌아왔을 때 그 줄만 열린 채로 남는다.
    expect(order).toEqual(["close", "delete"]);
    expect(onDelete).toHaveBeenCalledTimes(1);
    closeSpy.mockRestore();
  });

  it("한 줄을 열면 앞서 열려 있던 줄이 닫힌다", async () => {
    let first: renderer.ReactTestRenderer;
    let second: renderer.ReactTestRenderer;
    await act(async () => {
      first = renderer.create(
        <SwipeableRow actions={actions(jest.fn(), jest.fn())}>
          <Text>first</Text>
        </SwipeableRow>,
      );
      second = renderer.create(
        <SwipeableRow actions={actions(jest.fn(), jest.fn())}>
          <Text>second</Text>
        </SwipeableRow>,
      );
    });

    const firstRow = findSwipeable(first!);
    const secondRow = findSwipeable(second!);
    const firstClose = jest
      .spyOn(firstRow.instance as unknown as { close: () => void }, "close")
      .mockImplementation(() => undefined);

    await act(async () => {
      firstRow.props.onSwipeableWillOpen();
    });
    expect(firstClose).not.toHaveBeenCalled();

    // 열린 줄이 여럿 남으면 어느 것의 삭제를 누르는지 알 수 없다.
    await act(async () => {
      secondRow.props.onSwipeableWillOpen();
    });
    expect(firstClose).toHaveBeenCalledTimes(1);
    firstClose.mockRestore();
  });

  it("열려 있는 동안에는 줄을 눌러도 아래로 탭이 가지 않는다", async () => {
    // 지우려고 열어 둔 줄을 눌렀는데 그 호스트에 접속해 버리면 안 된다. 표준 동작은 그 탭이
    // 닫기만 하는 것이다.
    const onCardPress = jest.fn();
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <SwipeableRow actions={actions(jest.fn(), jest.fn())}>
          <Pressable accessibilityLabel="카드" onPress={onCardPress}>
            <Text>web-prod-01</Text>
          </Pressable>
        </SwipeableRow>,
      );
    });

    // 덮개는 이름 없는 눌림 영역이다 — 스크린리더가 읽을 것이 없어야 하므로 그 표시로 찾는다.
    const overlays = () =>
      tree!.root.findAll(
        node =>
          node.props.accessibilityElementsHidden === true &&
          typeof node.props.onPress === "function",
      );

    // 닫혀 있을 때는 덮개가 없다 — 평소 탭이 카드로 가야 한다.
    expect(overlays()).toHaveLength(0);

    await act(async () => {
      findSwipeable(tree!).props.onSwipeableWillOpen();
    });

    expect(overlays()).toHaveLength(1);
    await act(async () => {
      overlays()[0].props.onPress();
    });
    expect(onCardPress).not.toHaveBeenCalled();
  });

  it("바깥에서도 열린 줄을 닫을 수 있다", async () => {
    // 목록 스크롤·화면 이동은 이 줄을 모른다. 그쪽에서 부를 수 있어야 한다.
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <SwipeableRow actions={actions(jest.fn(), jest.fn())}>
          <Text>web-prod-01</Text>
        </SwipeableRow>,
      );
    });

    const row = findSwipeable(tree!);
    const closeSpy = jest
      .spyOn(row.instance as unknown as { close: () => void }, "close")
      .mockImplementation(() => undefined);

    await act(async () => {
      row.props.onSwipeableWillOpen();
    });
    closeOpenSwipeableRow();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    closeSpy.mockRestore();
  });
});
