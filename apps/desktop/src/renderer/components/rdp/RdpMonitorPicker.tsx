import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RdpLocalMonitor, RdpMonitorSelection } from "@shared";
import { Button } from "../../ui";
import { listRdpMonitors } from "../../services/desktop/rdp";
import {
  describeSelectionProblem,
  diagramRects,
  hasGaps,
  selectionBounds,
} from "./monitor-diagram";

interface RdpMonitorPickerProps {
  /** 지금 호스트에 저장된 선택. 비어 있으면 주 디스플레이만 켠 채로 연다. */
  selected: RdpMonitorSelection[] | null | undefined;
  onCancel: () => void;
  onApply: (monitors: RdpMonitorSelection[]) => void;
}

/**
 * 이 호스트에 빌려줄 로컬 모니터를 배치 그대로 고른다.
 *
 * mstsc 는 "모든 모니터 사용" 체크박스만 주고 일부만 고르려면 .rdp 파일을 직접 편집해야 한다.
 * 우리는 실제 배치를 알고 있으니 그림으로 보여준다 — 어느 사각형이 어느 화면인지 눈으로 맞출 수
 * 있어야 고를 수 있다.
 */
export function RdpMonitorPicker({
  selected,
  onCancel,
  onApply,
}: RdpMonitorPickerProps) {
  const { t: translate } = useTranslation();
  const [monitors, setMonitors] = useState<RdpLocalMonitor[] | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listRdpMonitors()
      .then((list) => {
        if (cancelled) {
          return;
        }
        setMonitors(list);

        // 저장된 선택을 지금 붙어 있는 화면에 맞춘다. id 는 재부팅으로 바뀔 수 있어 이름과
        // 크기로도 찾아본다 — 메인 프로세스의 대조와 같은 규칙이다.
        const saved = selected ?? [];
        const matched = new Set<number>();
        for (const want of saved) {
          const byId = list.find((m) => m.id === want.id);
          const hit =
            byId ??
            list.find(
              (m) =>
                !matched.has(m.id) &&
                m.label === want.label &&
                m.width === want.width &&
                m.height === want.height,
            );
          if (hit) {
            matched.add(hit.id);
          }
        }
        if (matched.size === 0) {
          const primary = list.find((m) => m.primary) ?? list[0];
          if (primary) {
            matched.add(primary.id);
          }
        }
        setChosen(matched);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const rects = useMemo(() => diagramRects(monitors ?? []), [monitors]);
  const chosenMonitors = useMemo(
    () => (monitors ?? []).filter((monitor) => chosen.has(monitor.id)),
    [monitors, chosen],
  );

  const problem = describeSelectionProblem(chosenMonitors);
  const box = selectionBounds(chosenMonitors);
  const gaps = hasGaps(chosenMonitors);

  // 주 디스플레이를 빼면 고른 것 중 첫 번째가 주가 된다. 시작 메뉴와 작업표시줄이 붙는 화면이라
  // 어디가 될지 미리 보여준다. 순서는 메인 프로세스와 같은 배치 순(위→아래, 왼→오른)이다.
  const primaryId = chosenMonitors.some((monitor) => monitor.primary)
    ? chosenMonitors.find((monitor) => monitor.primary)?.id
    : [...chosenMonitors].sort((a, b) => a.top - b.top || a.left - b.left)[0]
        ?.id;

  const toggle = (id: number) => {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-[rgba(4,8,15,0.55)] p-6 [-webkit-app-region:no-drag]">
      <div className="w-full max-w-[38rem] rounded-[0.9rem] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[0_20px_46px_rgba(0,0,0,0.34)]">
        <h3 className="text-[1.02rem] font-semibold text-[var(--text)]">
          {translate("rdpMonitors.title")}
        </h3>
        <p className="mt-1 text-[0.8rem] leading-[1.5] text-[var(--text-soft)]">
          {translate("rdpMonitors.description")}
        </p>

        {loadError ? (
          <p className="mt-4 text-[0.82rem] text-[var(--danger,#ef4444)]">
            {translate("rdpMonitors.loadFailed", { error: loadError })}
          </p>
        ) : monitors === null ? (
          <p className="mt-4 text-[0.82rem] text-[var(--text-soft)]">
            {translate("rdpMonitors.loading")}
          </p>
        ) : (
          <>
            {/* 실제 배치 그대로 그린다. 전체를 기준으로 잡아서 체크를 켜고 꺼도 그림이 움직이지
                않는다 — 움직이면 어디를 눌렀는지 따라가기 어렵다. */}
            <div className="relative mt-4 aspect-[16/9] w-full rounded-[0.6rem] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_70%,black_30%)]">
              {rects.map((rect) => {
                const monitor = monitors.find((item) => item.id === rect.id);
                if (!monitor) {
                  return null;
                }
                const on = chosen.has(rect.id);
                return (
                  <button
                    key={rect.id}
                    type="button"
                    aria-pressed={on}
                    aria-label={`${monitor.label} ${monitor.width}×${monitor.height}`}
                    onClick={() => toggle(rect.id)}
                    className={[
                      "absolute flex flex-col items-center justify-center gap-[0.15rem] rounded-[0.35rem] border-2 p-1 text-center transition-colors",
                      on
                        ? "border-[var(--accent-strong)] bg-[color-mix(in_srgb,var(--accent-strong)_26%,transparent)] text-[var(--text)]"
                        : "border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_86%,black_14%)] text-[var(--text-soft)]",
                    ].join(" ")}
                    style={{
                      left: `${rect.left}%`,
                      top: `${rect.top}%`,
                      width: `${rect.width}%`,
                      height: `${rect.height}%`,
                    }}
                  >
                    <span className="truncate text-[0.7rem] font-medium leading-tight">
                      {monitor.label}
                    </span>
                    <span className="text-[0.65rem] leading-tight opacity-80">
                      {monitor.width}×{monitor.height}
                    </span>
                    {on && rect.id === primaryId ? (
                      <span className="rounded-full bg-[var(--accent-strong)] px-[0.35rem] text-[0.6rem] leading-[1.3] text-white">
                        {translate("rdpMonitors.primary")}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>

            <div className="mt-3 min-h-[2.6rem] text-[0.78rem] leading-[1.5]">
              {problem ? (
                <p className="text-[var(--danger,#ef4444)]">{problem}</p>
              ) : (
                <p className="text-[var(--text-soft)]">
                  {translate(
                    gaps ? "rdpMonitors.desktopSizeGaps" : "rdpMonitors.desktopSize",
                    { width: box.width, height: box.height },
                  )}
                </p>
              )}
            </div>
          </>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {translate("common.cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={problem !== null}
            onClick={() =>
              onApply(
                chosenMonitors.map((monitor) => ({
                  id: monitor.id,
                  label: monitor.label,
                  width: monitor.width,
                  height: monitor.height,
                })),
              )
            }
          >
            {translate("rdpMonitors.apply")}
          </Button>
        </div>
      </div>
    </div>
  );
}
