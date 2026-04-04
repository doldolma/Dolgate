import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { resolveResponsiveCardGridLayout } from './responsive-card-grid';

interface UseResponsiveCardGridOptions {
  itemCount: number;
  minWidth: number;
  maxWidth: number;
  gap: number;
}

export function useResponsiveCardGrid({
  itemCount,
  minWidth,
  maxWidth,
  gap,
}: UseResponsiveCardGridOptions) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);

  const ref = useCallback((node: HTMLDivElement | null) => {
    setElement(node);
  }, []);

  useEffect(() => {
    if (!element) {
      setContainerWidth(null);
      return;
    }

    const updateWidth = (nextWidth: number) => {
      const normalizedWidth =
        Number.isFinite(nextWidth) && nextWidth > 0 ? nextWidth : 0;
      setContainerWidth((currentWidth) =>
        currentWidth === normalizedWidth ? currentWidth : normalizedWidth,
      );
    };

    const measure = () => {
      updateWidth(
        element.getBoundingClientRect().width ||
          element.clientWidth ||
          element.offsetWidth ||
          0,
      );
    };

    measure();

    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const resizeObserver = new ResizeObserver((entries) => {
      const matchingEntry = entries.find((entry) => entry.target === element);
      if (matchingEntry) {
        updateWidth(matchingEntry.contentRect.width);
        return;
      }
      measure();
    });

    resizeObserver.observe(element);

    return () => {
      resizeObserver.disconnect();
    };
  }, [element]);

  const layout = useMemo(
    () =>
      resolveResponsiveCardGridLayout({
        containerWidth,
        itemCount,
        minWidth,
        maxWidth,
        gap,
      }),
    [containerWidth, gap, itemCount, maxWidth, minWidth],
  );

  const style = useMemo<CSSProperties | undefined>(() => {
    if (!layout.hasMeasurement) {
      return undefined;
    }

    return layout.justifyContent === 'start'
      ? {
          gridTemplateColumns: layout.gridTemplateColumns,
          justifyContent: 'start',
        }
      : {
          gridTemplateColumns: layout.gridTemplateColumns,
        };
  }, [layout]);

  return {
    layout,
    ref,
    style,
  };
}
