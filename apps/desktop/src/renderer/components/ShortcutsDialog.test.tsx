import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShortcutsDialog } from './ShortcutsDialog';

describe('ShortcutsDialog', () => {
  afterEach(() => {
    delete document.documentElement.dataset.platform;
  });

  it.each([
    ['darwin', '⌘'],
    ['win32', 'Ctrl'],
  ])('shows the new-window shortcut for %s', (platform, modifier) => {
    document.documentElement.dataset.platform = platform;

    render(<ShortcutsDialog open onClose={vi.fn()} />);

    const shortcutRow = screen.getByText('새 창').parentElement;
    expect(shortcutRow).not.toBeNull();
    expect(within(shortcutRow!).getByText(modifier)).toBeInTheDocument();
    expect(within(shortcutRow!).getByText('N')).toBeInTheDocument();
  });
});
