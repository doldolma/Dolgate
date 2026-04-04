import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from './Button';
import { ModalBody, ModalFooter, ModalHeader, ModalShell } from './ModalShell';
import { NoticeCard } from './NoticeCard';
import { SplitButton, SplitButtonMain, SplitButtonMenu, SplitButtonMenuItem, SplitButtonToggle } from './SplitButton';
import { StatusBadge } from './StatusBadge';
import { Input } from './Input';

describe('renderer UI primitives', () => {
  it('renders button variants and disabled state', () => {
    render(
      <div>
        <Button variant="primary">Save</Button>
        <Button variant="secondary" disabled>
          Cancel
        </Button>
      </div>,
    );

    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('renders modal shell sections without legacy modal wrappers', () => {
    render(
      <ModalShell role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <ModalHeader>
          <h3 id="modal-title">Dialog title</h3>
        </ModalHeader>
        <ModalBody>
          <p>Dialog body</p>
        </ModalBody>
        <ModalFooter>
          <Button variant="primary">Confirm</Button>
        </ModalFooter>
      </ModalShell>,
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Dialog body')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
  });

  it('renders status badge and notice card variants', () => {
    render(
      <div>
        <StatusBadge tone="running">Running</StatusBadge>
        <NoticeCard title="Heads up" tone="info">
          <p>Body copy</p>
        </NoticeCard>
      </div>,
    );

    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('Heads up')).toBeInTheDocument();
    expect(screen.getByText('Body copy')).toBeInTheDocument();
  });

  it('renders split button actions and menu items', () => {
    render(
      <SplitButton>
        <SplitButtonMain>New Host</SplitButtonMain>
        <SplitButtonToggle aria-label="Open menu">v</SplitButtonToggle>
        <SplitButtonMenu>
          <SplitButtonMenuItem>Import from AWS</SplitButtonMenuItem>
        </SplitButtonMenu>
      </SplitButton>,
    );

    expect(screen.getByRole('button', { name: 'New Host' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open menu' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import from AWS' })).toBeInTheDocument();
  });

  it('renders core primitives safely under dark theme tokens', () => {
    document.documentElement.dataset.theme = 'dark';

    render(
      <div>
        <Button variant="primary">Continue</Button>
        <Input placeholder="Host" />
        <NoticeCard title="Dark mode" tone="info">
          <p>Theme smoke</p>
        </NoticeCard>
      </div>,
    );

    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Host')).toBeInTheDocument();
    expect(screen.getByText('Dark mode')).toBeInTheDocument();

    delete document.documentElement.dataset.theme;
  });
});
