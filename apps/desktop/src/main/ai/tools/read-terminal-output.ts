import type { AiTerminalOutputResponse, AiToolDef } from "../../../shared/ai";
import { redactSecrets } from "../redact";
import { t } from '../../i18n';

export interface TerminalOutputReadInput {
  beforeRecentLines: number;
  lines: number;
}

export type ReadTerminalOutput = (
  input: TerminalOutputReadInput,
  signal: AbortSignal,
) => Promise<AiTerminalOutputResponse>;

const DEFAULT_BEFORE_RECENT_LINES = 100;
const DEFAULT_LINES = 200;
const MAX_LINES = 500;
const MAX_BEFORE_RECENT_LINES = 100_000;
const MAX_OUTPUT_CHARS = 12_000;

export const READ_TERMINAL_OUTPUT_TOOL: AiToolDef = {
  name: "read_terminal_output",
  description:
    "Read older visible-terminal scrollback from the snapshot captured when the user sent this question. " +
    "Use this only when the automatically attached recent terminal output (usually the latest 100 lines) is not enough " +
    "and you need lines before that recent context. This is anchored to the question time and cannot see output produced later. " +
    "For fresh host state, prefer inspect_command.",
  parameters: {
    type: "object",
    properties: {
      beforeRecentLines: {
        type: "number",
        description:
          "How many latest snapshot lines to skip before reading. Default 100 means read before the auto-attached recent 100 lines. " +
          "Use 300 to read the range before a previous 200-line read of 101~300 lines ago.",
      },
      lines: {
        type: "number",
        description: "Number of older lines to read. Default 200, maximum 500.",
      },
    },
  },
};

export function normalizeTerminalOutputReadArgs(
  args: Record<string, unknown>,
): TerminalOutputReadInput {
  return {
    beforeRecentLines: clampInteger(
      args.beforeRecentLines,
      DEFAULT_BEFORE_RECENT_LINES,
      0,
      MAX_BEFORE_RECENT_LINES,
    ),
    lines: clampInteger(args.lines, DEFAULT_LINES, 1, MAX_LINES),
  };
}

export async function readTerminalOutputTool(
  args: Record<string, unknown>,
  readTerminalOutput: ReadTerminalOutput,
  signal: AbortSignal,
): Promise<string> {
  const input = normalizeTerminalOutputReadArgs(args);
  const response = await readTerminalOutput(input, signal);
  const label = response.rangeLabel ?? rangeLabel(input);
  if (response.error) {
    return `error: ${response.error}`;
  }

  const body = clip(redactSecrets(response.text ?? ""));
  const lines =
    typeof response.returnedLines === "number"
      ? t('readTerminal.lines', { count: response.returnedLines })
      : "";
  const parts = [
    t('readTerminal.header', { label, lines }),
    "",
    body || t('readTerminal.noOutput'),
  ];
  if (response.reachedStart) {
    parts.push("", t('readTerminal.snapshotStart'));
  }
  return parts.join("\n");
}

export function rangeLabel(input: TerminalOutputReadInput): string {
  return t('readTerminal.rangeLabel', {
    from: input.beforeRecentLines + 1,
    to: input.beforeRecentLines + input.lines,
  });
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(numberValue)));
}

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n…(truncated)`;
}
