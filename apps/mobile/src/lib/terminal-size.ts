import { Dimensions } from "react-native";

export interface TerminalGridSize {
  cols: number;
  rows: number;
}

const MOBILE_TERMINAL_RESERVED_HEIGHT = 176;
// Tuned against the mobile xterm render metrics so the terminal fills the card
// more closely on real Android devices without clipping under the keyboard.
const TERMINAL_CELL_WIDTH = 7.2;
const TERMINAL_CELL_HEIGHT = 16.4;

export function estimateTerminalGridSize(
  width: number,
  height: number,
): TerminalGridSize {
  return {
    cols: Math.max(32, Math.floor(width / TERMINAL_CELL_WIDTH)),
    rows: Math.max(18, Math.floor(height / TERMINAL_CELL_HEIGHT)),
  };
}

export function estimateTerminalGridSizeFromWindow(
  windowWidth: number,
  windowHeight: number,
): TerminalGridSize {
  return estimateTerminalGridSize(
    windowWidth,
    windowHeight - MOBILE_TERMINAL_RESERVED_HEIGHT,
  );
}

export function getCurrentWindowTerminalGridSize(): TerminalGridSize {
  const { width, height } = Dimensions.get("window");
  return estimateTerminalGridSizeFromWindow(width, height);
}

export function toRusshTerminalSize(size: TerminalGridSize): {
  colWidth: number;
  rowHeight: number;
} {
  return {
    colWidth: size.cols,
    rowHeight: size.rows,
  };
}
