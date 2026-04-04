export interface ResponsiveCardGridLayout {
  hasMeasurement: boolean;
  columns: number;
  cardWidth: number | null;
  gridTemplateColumns: string;
  justifyContent: 'normal' | 'start';
}

interface ResolveResponsiveCardGridLayoutInput {
  containerWidth: number | null;
  itemCount: number;
  minWidth: number;
  maxWidth: number;
  gap: number;
}

function formatPx(value: number): string {
  return `${Number(value.toFixed(3))}px`;
}

export function getResponsiveCardGridFallbackTemplate(minWidth: number): string {
  return `repeat(auto-fit, minmax(min(100%, ${minWidth}px), 1fr))`;
}

export function resolveResponsiveCardGridLayout({
  containerWidth,
  itemCount,
  minWidth,
  maxWidth,
  gap,
}: ResolveResponsiveCardGridLayoutInput): ResponsiveCardGridLayout {
  const fallbackTemplate = getResponsiveCardGridFallbackTemplate(minWidth);

  if (
    !Number.isFinite(containerWidth) ||
    containerWidth === null ||
    containerWidth <= 0 ||
    itemCount <= 0
  ) {
    return {
      hasMeasurement: false,
      columns: 0,
      cardWidth: null,
      gridTemplateColumns: fallbackTemplate,
      justifyContent: 'normal',
    };
  }

  const safeGap = Math.max(0, gap);
  const maxColumnsByMinWidth = Math.max(
    1,
    Math.floor((containerWidth + safeGap) / (minWidth + safeGap)),
  );
  const columns = Math.max(1, Math.min(itemCount, maxColumnsByMinWidth));
  const naturalCardWidth =
    (containerWidth - safeGap * (columns - 1)) / columns;
  const cardWidth = Math.min(naturalCardWidth, maxWidth);
  const shouldClampToMaxWidth = naturalCardWidth > maxWidth;

  return {
    hasMeasurement: true,
    columns,
    cardWidth,
    gridTemplateColumns: `repeat(${columns}, minmax(0, ${formatPx(cardWidth)}))`,
    justifyContent: shouldClampToMaxWidth ? 'start' : 'normal',
  };
}
