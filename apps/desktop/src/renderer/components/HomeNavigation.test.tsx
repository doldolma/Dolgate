import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HomeNavigation } from './HomeNavigation';

describe('HomeNavigation', () => {
  it('does not render Known Hosts or Keychain as top-level navigation items', () => {
    render(<HomeNavigation activeSection="hosts" onSelectSection={vi.fn()} />);

    expect(screen.getByRole('button', { name: /Hosts$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Port Forwarding$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Logs$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Settings$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Known Hosts' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Keychain' })).not.toBeInTheDocument();
  });
});
