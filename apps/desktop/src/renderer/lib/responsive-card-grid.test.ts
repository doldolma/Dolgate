import { describe, expect, it } from 'vitest';
import {
  getResponsiveCardGridFallbackTemplate,
  resolveResponsiveCardGridLayout,
} from './responsive-card-grid';

describe('resolveResponsiveCardGridLayout', () => {
  it('caps a single card at the maximum width', () => {
    const layout = resolveResponsiveCardGridLayout({
      containerWidth: 1200,
      itemCount: 1,
      minWidth: 280,
      maxWidth: 460,
      gap: 13.6,
    });

    expect(layout.columns).toBe(1);
    expect(layout.cardWidth).toBe(460);
    expect(layout.gridTemplateColumns).toBe('repeat(1, minmax(0, 460px))');
    expect(layout.justifyContent).toBe('start');
  });

  it('fills the row when multiple cards fit within the maximum width', () => {
    const layout = resolveResponsiveCardGridLayout({
      containerWidth: 1200,
      itemCount: 3,
      minWidth: 280,
      maxWidth: 460,
      gap: 13.6,
    });

    expect(layout.columns).toBe(3);
    expect(layout.cardWidth).toBeCloseTo(390.933, 3);
    expect(layout.gridTemplateColumns).toBe(
      'repeat(3, minmax(0, 390.933px))',
    );
    expect(layout.justifyContent).toBe('normal');
  });

  it('reduces the number of columns as the container narrows', () => {
    const layout = resolveResponsiveCardGridLayout({
      containerWidth: 700,
      itemCount: 4,
      minWidth: 280,
      maxWidth: 460,
      gap: 13.6,
    });

    expect(layout.columns).toBe(2);
    expect(layout.cardWidth).toBeCloseTo(343.2, 3);
    expect(layout.justifyContent).toBe('normal');
  });

  it('falls back to a single full-width column when the container is narrower than the minimum', () => {
    const layout = resolveResponsiveCardGridLayout({
      containerWidth: 220,
      itemCount: 3,
      minWidth: 280,
      maxWidth: 460,
      gap: 13.6,
    });

    expect(layout.columns).toBe(1);
    expect(layout.cardWidth).toBe(220);
    expect(layout.gridTemplateColumns).toBe('repeat(1, minmax(0, 220px))');
  });

  it('returns the CSS fallback template when the grid is not measurable yet', () => {
    const fallbackTemplate = getResponsiveCardGridFallbackTemplate(280);
    const layout = resolveResponsiveCardGridLayout({
      containerWidth: null,
      itemCount: 2,
      minWidth: 280,
      maxWidth: 460,
      gap: 13.6,
    });

    expect(layout.hasMeasurement).toBe(false);
    expect(layout.gridTemplateColumns).toBe(fallbackTemplate);
  });
});
