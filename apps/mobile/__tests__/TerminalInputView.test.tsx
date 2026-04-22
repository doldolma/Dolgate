import React from "react";
import renderer, { act } from "react-test-renderer";

jest.mock("react-native", () => {
  const mockReact = require("react") as typeof React;
  const mockDispatchViewManagerCommand = jest.fn();
  const mockGetViewManagerConfig = jest.fn(() => ({
    Commands: {
      focus: 1,
      blur: 2,
    },
  }));
  const mockFindNodeHandle = jest.fn(() => 4242);

  return {
    __mockDispatchViewManagerCommand: mockDispatchViewManagerCommand,
    __mockGetViewManagerConfig: mockGetViewManagerConfig,
    __mockFindNodeHandle: mockFindNodeHandle,
    findNodeHandle: mockFindNodeHandle,
    requireNativeComponent: jest.fn(() =>
      mockReact.forwardRef((props: Record<string, unknown>, ref: React.ForwardedRef<unknown>) => {
        mockReact.useImperativeHandle(ref, () => ({ native: true }), []);
        return mockReact.createElement("TerminalInputView", props);
      }),
    ),
    UIManager: {
      getViewManagerConfig: mockGetViewManagerConfig,
      dispatchViewManagerCommand: mockDispatchViewManagerCommand,
    },
  };
});

const ReactNative = require("react-native") as {
  __mockDispatchViewManagerCommand: jest.Mock;
  __mockGetViewManagerConfig: jest.Mock;
  __mockFindNodeHandle: jest.Mock;
};

import { TerminalInputView } from "../src/components/TerminalInputView";

describe("TerminalInputView", () => {
  beforeEach(() => {
    ReactNative.__mockDispatchViewManagerCommand.mockClear();
    ReactNative.__mockGetViewManagerConfig.mockClear();
    ReactNative.__mockFindNodeHandle.mockClear();
  });

  it("passes Android keyboard mode props to the native view", () => {
    let tree: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <TerminalInputView
          focused
          focusToken={3}
          clearToken={4}
          softKeyboardEnabled={false}
        />,
      );
    });

    const nativeInput = tree!.root.find(
      (node) => (node.type as unknown) === "TerminalInputView",
    );

    expect(nativeInput.props.focused).toBe(true);
    expect(nativeInput.props.focusToken).toBe(3);
    expect(nativeInput.props.clearToken).toBe(4);
    expect(nativeInput.props.softKeyboardEnabled).toBe(false);

    act(() => {
      tree!.unmount();
    });
  });

  it("dispatches native focus and blur commands through the view manager", () => {
    const ref = React.createRef<{
      focus: () => void;
      blur: () => void;
    }>();

    let tree: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<TerminalInputView ref={ref} />);
    });

    expect(ref.current).not.toBeNull();

    act(() => {
      ref.current!.focus();
      ref.current!.blur();
    });

    expect(ReactNative.__mockGetViewManagerConfig).toHaveBeenCalledWith(
      "TerminalInputView",
    );
    expect(ReactNative.__mockFindNodeHandle).toHaveBeenCalled();
    expect(ReactNative.__mockDispatchViewManagerCommand).toHaveBeenNthCalledWith(
      1,
      4242,
      1,
      [],
    );
    expect(ReactNative.__mockDispatchViewManagerCommand).toHaveBeenNthCalledWith(
      2,
      4242,
      2,
      [],
    );

    act(() => {
      tree!.unmount();
    });
  });
});
