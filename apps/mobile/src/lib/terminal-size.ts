import { Dimensions } from "react-native";

export interface TerminalGridSize {
  cols: number;
  rows: number;
}

const MOBILE_TERMINAL_RESERVED_HEIGHT = 176;
const TERMINAL_CELL_WIDTH = 8;
const TERMINAL_CELL_HEIGHT = 18;

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
