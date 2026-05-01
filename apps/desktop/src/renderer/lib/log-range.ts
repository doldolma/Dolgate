import type {
  LogsAbsoluteRangeValue,
  LogsRangeMode,
  LogsRelativePresetKey,
  LogsRelativeRangeValue,
  LogsRelativeUnit,
} from "../store/createAppStore";

export const LOGS_RANGE_WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];

export const LOGS_RELATIVE_RANGE_PRESET_OPTIONS: Array<{
  key: LogsRelativePresetKey;
  label: string;
  amount: number;
  unit: LogsRelativeUnit;
}> = [
  { key: "30m", label: "30분 전부터", amount: 30, unit: "minute" },
  { key: "1h", label: "1시간 전부터", amount: 1, unit: "hour" },
  { key: "6h", label: "6시간 전부터", amount: 6, unit: "hour" },
  { key: "1d", label: "1일 전부터", amount: 1, unit: "day" },
  { key: "3d", label: "3일 전부터", amount: 3, unit: "day" },
  { key: "1w", label: "1주 전부터", amount: 1, unit: "week" },
];

export const LOGS_RELATIVE_RANGE_UNIT_OPTIONS: Array<{
  value: LogsRelativeUnit;
  label: string;
}> = [
  { value: "second", label: "초" },
  { value: "minute", label: "분" },
  { value: "hour", label: "시간" },
  { value: "day", label: "일" },
  { value: "week", label: "주" },
  { value: "month", label: "월" },
  { value: "year", label: "년" },
];

function padRangeValue(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatLocalDateInputValue(date: Date): string {
  return `${date.getFullYear()}-${padRangeValue(date.getMonth() + 1)}-${padRangeValue(date.getDate())}`;
}

export function formatLocalTimeInputValue(date: Date): string {
  return `${padRangeValue(date.getHours())}:${padRangeValue(date.getMinutes())}:${padRangeValue(date.getSeconds())}`;
}

export function parseLocalDateTime(
  dateValue: string,
  timeValue: string,
): Date | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue.trim());
  if (!dateMatch) {
    return null;
  }
  const timeMatch = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(timeValue.trim());
  if (!timeMatch) {
    return null;
  }

  const parsed = new Date(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
    Number(timeMatch[3] ?? "0"),
    0,
  );
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function createDefaultLogsAbsoluteRange(): LogsAbsoluteRangeValue {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 60 * 1000);
  return {
    startDate: formatLocalDateInputValue(start),
    startTime: formatLocalTimeInputValue(start),
    endDate: formatLocalDateInputValue(end),
    endTime: formatLocalTimeInputValue(end),
  };
}

export function createDefaultLogsRelativeRange(): LogsRelativeRangeValue {
  return {
    presetKey: "30m",
    amount: "30",
    unit: "minute",
  };
}

export function subtractLogsRelativeRange(
  end: Date,
  amount: number,
  unit: LogsRelativeUnit,
): Date {
  const start = new Date(end);
  if (unit === "second") {
    start.setSeconds(start.getSeconds() - amount);
  } else if (unit === "minute") {
    start.setMinutes(start.getMinutes() - amount);
  } else if (unit === "hour") {
    start.setHours(start.getHours() - amount);
  } else if (unit === "day") {
    start.setDate(start.getDate() - amount);
  } else if (unit === "week") {
    start.setDate(start.getDate() - amount * 7);
  } else if (unit === "month") {
    start.setMonth(start.getMonth() - amount);
  } else if (unit === "year") {
    start.setFullYear(start.getFullYear() - amount);
  }
  return start;
}

export function normalizeLogsRelativeRange(
  value: LogsRelativeRangeValue | null,
  now = new Date(),
): { startTime: string; endTime: string } | null {
  if (!value) {
    return null;
  }
  const preset = LOGS_RELATIVE_RANGE_PRESET_OPTIONS.find(
    (option) => option.key === value.presetKey,
  );
  const resolvedAmount =
    value.presetKey === "custom"
      ? Number(value.amount)
      : preset?.amount ?? Number.NaN;
  const resolvedUnit =
    value.presetKey === "custom" ? value.unit : preset?.unit ?? value.unit;
  if (!Number.isFinite(resolvedAmount) || resolvedAmount <= 0) {
    return null;
  }
  const end = new Date(now);
  const start = subtractLogsRelativeRange(end, resolvedAmount, resolvedUnit);
  return {
    startTime: start.toISOString(),
    endTime: end.toISOString(),
  };
}

export function normalizeLogsAbsoluteRange(
  value: LogsAbsoluteRangeValue | null,
): { startTime: string; endTime: string } | null {
  if (!value) {
    return null;
  }
  const start = parseLocalDateTime(value.startDate, value.startTime);
  const end = parseLocalDateTime(value.endDate, value.endTime);
  if (!start || !end || end.getTime() < start.getTime()) {
    return null;
  }
  return {
    startTime: start.toISOString(),
    endTime: end.toISOString(),
  };
}

export function formatLogsRangeLabel(
  mode: LogsRangeMode,
  absoluteValue: LogsAbsoluteRangeValue | null,
  relativeValue: LogsRelativeRangeValue | null,
): string {
  if (mode === "absolute" && absoluteValue) {
    return `${absoluteValue.startDate.replace(/-/g, "/")} ${absoluteValue.startTime.slice(0, 5)} - ${absoluteValue.endDate.replace(/-/g, "/")} ${absoluteValue.endTime.slice(0, 5)}`;
  }
  const preset = LOGS_RELATIVE_RANGE_PRESET_OPTIONS.find(
    (option) => option.key === relativeValue?.presetKey,
  );
  if (relativeValue?.presetKey === "custom") {
    return `최근 ${relativeValue.amount || "0"}${LOGS_RELATIVE_RANGE_UNIT_OPTIONS.find((option) => option.value === relativeValue.unit)?.label ?? ""}`;
  }
  return preset ? `최근 ${preset.label.replace(" 전부터", "")}` : "최근 30분";
}

export function startOfRangeMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function addRangeMonths(date: Date, months: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

export function buildRangeCalendarDays(month: Date): Date[] {
  const firstDay = startOfRangeMonth(month);
  const gridStart = new Date(firstDay);
  gridStart.setDate(firstDay.getDate() - firstDay.getDay());
  return Array.from({ length: 42 }, (_, index) => {
    const next = new Date(gridStart);
    next.setDate(gridStart.getDate() + index);
    return next;
  });
}

export function formatRangeMonthLabel(date: Date): string {
  return `${date.getFullYear()}년 ${date.getMonth() + 1}월`;
}

export function formatRangeDayValue(date: Date): string {
  return formatLocalDateInputValue(date);
}
