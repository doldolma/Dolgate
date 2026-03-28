import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";

export type MetricChartValueFormat = "percent" | "bytesPerSecond";
export type MetricChartSeriesTone = "primary" | "secondary";

export interface MetricChartSeriesDefinition {
  label: string;
  values: number[];
  tone: MetricChartSeriesTone;
  format: MetricChartValueFormat;
}

interface MetricChartTooltipState {
  left: number;
  top: number;
  timestamp: number;
  rows: Array<{
    label: string;
    value: string;
    tone: MetricChartSeriesTone;
  }>;
}

interface UPlotMetricChartProps {
  title: string;
  currentLabel: string;
  timestamps: number[];
  series: MetricChartSeriesDefinition[];
  yFormat: MetricChartValueFormat;
  fixedRange?: readonly [number, number];
}

const METRIC_CHART_HEIGHT = 180;
const METRIC_TOOLTIP_WIDTH = 184;

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const digits = size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
}

function formatBytesPerSecond(value: number): string {
  return `${formatBytes(value)}/s`;
}

function formatPercentValue(value: number): string {
  if (!Number.isFinite(value)) {
    return "0%";
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)}%`;
}

function formatMetricValue(
  value: number,
  format: MetricChartValueFormat,
): string {
  return format === "percent"
    ? formatPercentValue(value)
    : formatBytesPerSecond(value);
}

function formatMetricsAxisTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function formatMetricsTooltipTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function resolveCssColor(
  element: HTMLElement,
  variableName: string,
  fallback: string,
): string {
  const value = getComputedStyle(element).getPropertyValue(variableName).trim();
  return value || fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function buildChartData(
  timestamps: number[],
  series: MetricChartSeriesDefinition[],
): uPlot.AlignedData {
  return [timestamps, ...series.map((definition) => definition.values)];
}

export function UPlotMetricChart({
  title,
  currentLabel,
  timestamps,
  series,
  yFormat,
  fixedRange,
}: UPlotMetricChartProps) {
  const plotContainerRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);
  const latestDataRef = useRef({ timestamps, series });
  const [tooltip, setTooltip] = useState<MetricChartTooltipState | null>(null);

  const seriesKey = useMemo(
    () => series.map((item) => `${item.label}:${item.tone}`).join("|"),
    [series],
  );
  const chartData = useMemo(() => buildChartData(timestamps, series), [
    series,
    timestamps,
  ]);
  const fixedRangeKey = fixedRange ? fixedRange.join(":") : "auto";

  latestDataRef.current = { timestamps, series };

  useLayoutEffect(() => {
    const container = plotContainerRef.current;
    if (!container) {
      return;
    }

    const primaryStroke = resolveCssColor(
      container,
      "--accent-strong",
      "#5b7cff",
    );
    const secondaryStroke = resolveCssColor(
      container,
      "--success-text",
      "#14b86a",
    );
    const axisStroke = resolveCssColor(
      container,
      "--text-soft",
      "rgba(110, 126, 155, 0.9)",
    );
    const gridStroke = resolveCssColor(
      container,
      "--border",
      "rgba(151, 164, 188, 0.28)",
    );

    const options: uPlot.Options = {
      width: Math.max(Math.round(container.clientWidth) || 280, 240),
      height: METRIC_CHART_HEIGHT,
      padding: [8, 8, 4, 8],
      legend: {
        show: false,
      },
      scales: {
        x: {
          time: false,
        },
        y: fixedRange
          ? {
              range: [fixedRange[0], fixedRange[1]],
            }
          : {},
      },
      axes: [
        {
          stroke: axisStroke,
          grid: {
            stroke: gridStroke,
            width: 1,
          },
          ticks: {
            stroke: axisStroke,
            width: 1,
            size: 4,
          },
          values: (_self, splits) =>
            splits.map((value) => formatMetricsAxisTime(Number(value))),
        },
        {
          stroke: axisStroke,
          grid: {
            stroke: gridStroke,
            width: 1,
          },
          ticks: {
            stroke: axisStroke,
            width: 1,
            size: 4,
          },
          values: (_self, splits) =>
            splits.map((value) => formatMetricValue(Number(value), yFormat)),
        },
      ],
      series: [
        {},
        ...series.map((definition) => ({
          label: definition.label,
          stroke:
            definition.tone === "primary" ? primaryStroke : secondaryStroke,
          width: 2,
          points: {
            show: false,
          },
        })),
      ],
      cursor: {
        x: true,
        y: true,
        points: {
          show: false,
        },
        drag: {
          setScale: false,
          x: false,
          y: false,
        },
      },
      hooks: {
        setCursor: [
          (plot) => {
            const idx = plot.cursor.idx;
            const cursorLeft = plot.cursor.left;
            const cursorTop = plot.cursor.top;
            if (
              idx == null ||
              idx < 0 ||
              idx >= latestDataRef.current.timestamps.length ||
              cursorLeft == null ||
              cursorTop == null
            ) {
              setTooltip(null);
              return;
            }

            const rawLeft = cursorLeft + plot.bbox.left + 12;
            const rawTop = cursorTop + plot.bbox.top + 12;
            const maxLeft = Math.max(
              (container.clientWidth || plot.width || 280) - METRIC_TOOLTIP_WIDTH,
              8,
            );
            setTooltip({
              left: clamp(rawLeft, 8, maxLeft),
              top: Math.max(rawTop, 8),
              timestamp: latestDataRef.current.timestamps[idx],
              rows: latestDataRef.current.series.map((definition) => ({
                label: definition.label,
                value: formatMetricValue(
                  definition.values[idx] ?? 0,
                  definition.format,
                ),
                tone: definition.tone,
              })),
            });
          },
        ],
      },
    };

    const plot = new uPlot(options, chartData, container);
    plotRef.current = plot;

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) {
          return;
        }
        plot.setSize({
          width: Math.max(Math.round(entry.contentRect.width) || 280, 240),
          height: METRIC_CHART_HEIGHT,
        });
      });
      resizeObserver.observe(container);
    }

    return () => {
      resizeObserver?.disconnect();
      plot.destroy();
      plotRef.current = null;
      setTooltip(null);
    };
  }, [fixedRangeKey, seriesKey, yFormat]);

  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) {
      return;
    }
    plot.setData(chartData);
  }, [chartData]);

  return (
    <div className="containers-workspace__metric-chart-card">
      <div className="containers-workspace__metric-chart-header">
        <strong>{title}</strong>
        <span>{currentLabel}</span>
      </div>
      <div className="containers-workspace__metric-plot-shell">
        <div
          ref={plotContainerRef}
          className="containers-workspace__metric-plot"
          data-testid={`metric-plot:${title}`}
        />
        {tooltip ? (
          <div
            className="containers-workspace__metric-tooltip"
            style={{
              left: `${tooltip.left}px`,
              top: `${tooltip.top}px`,
            }}
          >
            <strong>{formatMetricsTooltipTime(tooltip.timestamp)}</strong>
            <div className="containers-workspace__metric-tooltip-rows">
              {tooltip.rows.map((row) => (
                <div
                  key={`${row.label}:${row.value}`}
                  className="containers-workspace__metric-tooltip-row"
                >
                  <span
                    className={`containers-workspace__metric-tooltip-swatch containers-workspace__metric-tooltip-swatch--${row.tone}`}
                    aria-hidden="true"
                  />
                  <span>{row.label}</span>
                  <strong>{row.value}</strong>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
