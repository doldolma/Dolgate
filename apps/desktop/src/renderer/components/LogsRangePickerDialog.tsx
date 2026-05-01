import { useCallback, useEffect, useState } from "react";
import { cn } from "../lib/cn";
import {
  addRangeMonths,
  buildRangeCalendarDays,
  createDefaultLogsAbsoluteRange,
  createDefaultLogsRelativeRange,
  formatRangeDayValue,
  formatRangeMonthLabel,
  LOGS_RANGE_WEEKDAY_LABELS,
  LOGS_RELATIVE_RANGE_PRESET_OPTIONS,
  LOGS_RELATIVE_RANGE_UNIT_OPTIONS,
  normalizeLogsAbsoluteRange,
  normalizeLogsRelativeRange,
  parseLocalDateTime,
  startOfRangeMonth,
} from "../lib/log-range";
import type {
  LogsAbsoluteRangeValue,
  LogsRangeMode,
  LogsRelativeRangeValue,
  LogsRelativeUnit,
} from "../store/createAppStore";
import {
  Button,
  FieldGroup,
  IconButton,
  Input,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalShell,
  NoticeCard,
  SelectField,
  TabButton,
  Tabs,
} from "../ui";

export function LogsRangePickerDialog({
  open,
  mode,
  absoluteValue,
  relativeValue,
  onClose,
  onApply,
}: {
  open: boolean;
  mode: LogsRangeMode;
  absoluteValue: LogsAbsoluteRangeValue | null;
  relativeValue: LogsRelativeRangeValue | null;
  onClose: () => void;
  onApply: (
    nextMode: LogsRangeMode,
    nextAbsoluteValue: LogsAbsoluteRangeValue | null,
    nextRelativeValue: LogsRelativeRangeValue | null,
  ) => void;
}) {
  const [draftMode, setDraftMode] = useState<LogsRangeMode>(mode);
  const [draftAbsoluteValue, setDraftAbsoluteValue] = useState<LogsAbsoluteRangeValue>(
    absoluteValue ?? createDefaultLogsAbsoluteRange(),
  );
  const [draftRelativeValue, setDraftRelativeValue] = useState<LogsRelativeRangeValue>(
    relativeValue ?? createDefaultLogsRelativeRange(),
  );
  const [anchorMonth, setAnchorMonth] = useState<Date>(() => {
    const baseDate =
      parseLocalDateTime(
        (absoluteValue ?? createDefaultLogsAbsoluteRange()).startDate,
        "00:00:00",
      ) ?? new Date();
    return startOfRangeMonth(baseDate);
  });
  const [selectionCursor, setSelectionCursor] = useState<"start" | "end">(
    "start",
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const nextAbsoluteValue = absoluteValue ?? createDefaultLogsAbsoluteRange();
    setDraftMode(mode);
    setDraftAbsoluteValue(nextAbsoluteValue);
    setDraftRelativeValue(relativeValue ?? createDefaultLogsRelativeRange());
    setAnchorMonth(
      startOfRangeMonth(
        parseLocalDateTime(nextAbsoluteValue.startDate, "00:00:00") ?? new Date(),
      ),
    );
    setSelectionCursor("start");
    setError(null);
  }, [absoluteValue, mode, open, relativeValue]);

  const normalizedDraftAbsolute = normalizeLogsAbsoluteRange(draftAbsoluteValue);
  const startDateValue = draftAbsoluteValue.startDate;
  const endDateValue = draftAbsoluteValue.endDate;

  const handleSelectDay = useCallback((dateValue: string) => {
    setDraftMode("absolute");
    setError(null);
    setDraftAbsoluteValue((previous) => {
      if (selectionCursor === "start") {
        return {
          ...previous,
          startDate: dateValue,
          endDate: previous.endDate < dateValue ? dateValue : previous.endDate,
        };
      }
      if (dateValue < previous.startDate) {
        return {
          ...previous,
          startDate: dateValue,
          endDate: previous.startDate,
        };
      }
      return {
        ...previous,
        endDate: dateValue,
      };
    });
    setSelectionCursor((previous) => (previous === "start" ? "end" : "start"));
  }, [selectionCursor]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-[8] grid place-items-center bg-[rgba(12,20,32,0.32)]"
      role="presentation"
      onClick={() => {
        onClose();
      }}
    >
      <ModalShell
        size="lg"
        role="dialog"
        aria-modal="true"
        aria-label="로그 범위 선택"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <ModalHeader>
          <Tabs role="tablist" aria-label="로그 범위 모드">
            <TabButton
              role="tab"
              active={draftMode === "recent"}
              aria-selected={draftMode === "recent"}
              onClick={() => {
                setDraftMode("recent");
                setError(null);
              }}
            >
              상대 범위
            </TabButton>
            <TabButton
              role="tab"
              active={draftMode === "absolute"}
              aria-selected={draftMode === "absolute"}
              onClick={() => {
                setDraftMode("absolute");
                setError(null);
              }}
            >
              절대 범위
            </TabButton>
          </Tabs>
        </ModalHeader>

        {draftMode === "absolute" ? (
          <ModalBody className="w-[min(1040px,100%)]">
            <div className="grid items-start gap-[0.9rem] lg:grid-cols-[auto_minmax(0,1fr)_auto]">
              <IconButton
                size="sm"
                aria-label="이전 달"
                onClick={() => {
                  setAnchorMonth((previous) => addRangeMonths(previous, -1));
                }}
              >
                {"<"}
              </IconButton>
              <div className="grid gap-4 lg:grid-cols-2">
                {[anchorMonth, addRangeMonths(anchorMonth, 1)].map((month) => {
                  const monthKey = `${month.getFullYear()}-${month.getMonth()}`;
                  const monthValue = month.getMonth();
                  return (
                    <section
                      key={monthKey}
                      className="grid gap-3"
                    >
                      <header className="flex min-h-8 items-center justify-center">
                        <strong>{formatRangeMonthLabel(month)}</strong>
                      </header>
                      <div className="grid grid-cols-7 gap-[0.35rem] text-center text-[0.82rem] font-semibold text-[var(--text-soft)]">
                        {LOGS_RANGE_WEEKDAY_LABELS.map((label) => (
                          <span key={`${monthKey}:${label}`}>{label}</span>
                        ))}
                      </div>
                      <div className="grid grid-cols-7 gap-[0.28rem]">
                        {buildRangeCalendarDays(month).map((day) => {
                          const dayValue = formatRangeDayValue(day);
                          const isCurrentMonth = day.getMonth() === monthValue;
                          const isStart = dayValue === startDateValue;
                          const isEnd = dayValue === endDateValue;
                          const isInRange =
                            dayValue >= startDateValue && dayValue <= endDateValue;
                          return (
                            <button
                              key={`${monthKey}:${dayValue}`}
                              type="button"
                              className={cn(
                                "min-h-[2.6rem] rounded-[12px] border border-transparent bg-transparent font-semibold text-[var(--text)] transition-[background,border-color,color] duration-150 hover:border-[color-mix(in_srgb,var(--accent-strong)_30%,var(--border)_70%)] hover:bg-[color-mix(in_srgb,var(--accent-strong)_10%,transparent_90%)]",
                                !isCurrentMonth
                                  ? "text-[color-mix(in_srgb,var(--text-soft)_78%,transparent_22%)]"
                                  : "",
                                isInRange
                                  ? "border-[color-mix(in_srgb,var(--accent-strong)_36%,var(--border)_64%)] bg-[color-mix(in_srgb,var(--accent-strong)_12%,transparent_88%)]"
                                  : "",
                                isStart || isEnd
                                  ? "border-[color-mix(in_srgb,var(--accent-strong)_68%,var(--border)_32%)] bg-[var(--accent-strong)] text-white"
                                  : "",
                              )}
                              onClick={() => {
                                handleSelectDay(dayValue);
                              }}
                            >
                              {day.getDate()}
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  );
                })}
              </div>
              <IconButton
                size="sm"
                aria-label="다음 달"
                onClick={() => {
                  setAnchorMonth((previous) => addRangeMonths(previous, 1));
                }}
              >
                {">"}
              </IconButton>
            </div>

            <div className="mt-4 grid gap-[0.85rem_0.9rem] md:grid-cols-2 xl:grid-cols-4">
              <FieldGroup label="시작 날짜">
                <Input
                  type="date"
                  value={draftAbsoluteValue.startDate}
                  onChange={(event) => {
                    setDraftAbsoluteValue((previous) => ({
                      ...previous,
                      startDate: event.target.value,
                    }));
                  }}
                />
              </FieldGroup>
              <FieldGroup label="시작 시간">
                <Input
                  type="time"
                  step="1"
                  value={draftAbsoluteValue.startTime}
                  onChange={(event) => {
                    setDraftAbsoluteValue((previous) => ({
                      ...previous,
                      startTime: event.target.value,
                    }));
                  }}
                />
              </FieldGroup>
              <FieldGroup label="종료 날짜">
                <Input
                  type="date"
                  value={draftAbsoluteValue.endDate}
                  onChange={(event) => {
                    setDraftAbsoluteValue((previous) => ({
                      ...previous,
                      endDate: event.target.value,
                    }));
                  }}
                />
              </FieldGroup>
              <FieldGroup label="종료 시간">
                <Input
                  type="time"
                  step="1"
                  value={draftAbsoluteValue.endTime}
                  onChange={(event) => {
                    setDraftAbsoluteValue((previous) => ({
                      ...previous,
                      endTime: event.target.value,
                    }));
                  }}
                />
              </FieldGroup>
            </div>
            <p className="mt-3 text-[0.84rem] leading-[1.6] text-[var(--text-soft)]">
              날짜는 로컬 시간대로 적용됩니다. 절대 범위를 적용하면 Follow는 자동으로 꺼집니다.
            </p>
          </ModalBody>
        ) : (
          <ModalBody className="grid items-start gap-5 lg:grid-cols-[13.5rem_minmax(20rem,24rem)]">
            <div className="grid content-start gap-[0.55rem]">
              {LOGS_RELATIVE_RANGE_PRESET_OPTIONS.map((option) => (
                <label
                  key={option.key}
                  className="grid min-h-[2.25rem] grid-cols-[1rem_minmax(0,1fr)] items-center gap-[0.85rem] text-[0.98rem] font-semibold text-[var(--text)]"
                >
                  <input
                    type="radio"
                    name="logs-relative-range"
                    className="m-0 h-4 w-4 justify-self-center accent-[var(--accent-strong)]"
                    checked={draftRelativeValue.presetKey === option.key}
                    onChange={() => {
                      setDraftRelativeValue({
                        presetKey: option.key,
                        amount: String(option.amount),
                        unit: option.unit,
                      });
                    }}
                  />
                  <span className="whitespace-nowrap leading-none">{option.label}</span>
                </label>
              ))}
              <label className="mt-1 grid min-h-[2.25rem] grid-cols-[1rem_minmax(0,1fr)] items-center gap-[0.85rem] text-[0.98rem] font-semibold text-[var(--text)]">
                <input
                  type="radio"
                  name="logs-relative-range"
                  className="m-0 h-4 w-4 justify-self-center accent-[var(--accent-strong)]"
                  checked={draftRelativeValue.presetKey === "custom"}
                  onChange={() => {
                    setDraftRelativeValue((previous) => ({
                      ...previous,
                      presetKey: "custom",
                    }));
                  }}
                />
                <span className="whitespace-nowrap leading-none">사용자 지정 범위</span>
              </label>
            </div>
            <div className="grid max-w-[24rem] items-end gap-[0.9rem] lg:grid-cols-[minmax(0,1fr)_11.25rem]">
              <FieldGroup label="기간">
                <Input
                  type="number"
                  min="1"
                  value={draftRelativeValue.amount}
                  disabled={draftRelativeValue.presetKey !== "custom"}
                  onChange={(event) => {
                    setDraftRelativeValue((previous) => ({
                      ...previous,
                      presetKey: "custom",
                      amount: event.target.value,
                    }));
                  }}
                />
              </FieldGroup>
              <FieldGroup label="단위">
                <SelectField
                  value={draftRelativeValue.unit}
                  disabled={draftRelativeValue.presetKey !== "custom"}
                  onChange={(event) => {
                    setDraftRelativeValue((previous) => ({
                      ...previous,
                      presetKey: "custom",
                      unit: event.target.value as LogsRelativeUnit,
                    }));
                  }}
                >
                  {LOGS_RELATIVE_RANGE_UNIT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </SelectField>
              </FieldGroup>
            </div>
            <p className="text-[0.84rem] leading-[1.6] text-[var(--text-soft)] lg:col-span-2">
              상대 범위를 적용하면 현재 시점을 기준으로 범위를 계산해 다시 조회합니다.
            </p>
          </ModalBody>
        )}

        {error ? (
          <div className="px-6 pb-2">
            <NoticeCard tone="danger" role="alert">
              {error}
            </NoticeCard>
          </div>
        ) : null}

        <ModalFooter>
          <Button
            variant="secondary"
            onClick={() => {
              onClose();
            }}
          >
            취소
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              if (draftMode === "absolute" && !normalizedDraftAbsolute) {
                setError("시작 시간과 종료 시간을 확인해 주세요.");
                return;
              }
              if (
                draftMode === "recent" &&
                !normalizeLogsRelativeRange(draftRelativeValue)
              ) {
                setError("상대 범위 값을 확인해 주세요.");
                return;
              }
              onApply(
                draftMode,
                draftMode === "absolute" ? draftAbsoluteValue : null,
                draftMode === "recent" ? draftRelativeValue : null,
              );
            }}
          >
            적용
          </Button>
        </ModalFooter>
      </ModalShell>
    </div>
  );
}
