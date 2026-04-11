import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button';
import { FieldGroup } from './FieldGroup';
import { FilterRow } from './FilterRow';
import { Input } from './Input';
import { ModalBody, ModalFooter, ModalHeader, ModalShell } from './ModalShell';
import { NoticeCard } from './NoticeCard';
import { OptionCard } from './OptionCard';
import { PanelSection } from './PanelSection';
import { SplitButton, SplitButtonMain, SplitButtonMenu, SplitButtonMenuItem, SplitButtonToggle } from './SplitButton';
import { StatusBadge } from './StatusBadge';
import { TagInputField } from './TagInputField';
import { ToggleSwitch } from './ToggleSwitch';
import { Toolbar } from './Toolbar';

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

    const saveButton = screen.getByRole('button', { name: 'Save' });
    const cancelButton = screen.getByRole('button', { name: 'Cancel' });

    expect(saveButton).toBeEnabled();
    expect(cancelButton).toBeDisabled();
    expect(saveButton.className).toContain('shadow-none');
    expect(saveButton.className).not.toContain('hover:-translate-y-[1px]');
    expect(cancelButton.className).toContain('border-[var(--border)]');
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

    const dialog = screen.getByRole('dialog');
    const header = dialog.children.item(0);
    const body = dialog.children.item(1);
    const footer = dialog.children.item(2);

    expect(dialog).toBeInTheDocument();
    expect(screen.getByText('Dialog body')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
    expect(dialog).toHaveClass('flex', 'flex-col', 'overflow-hidden', 'max-h-[calc(100vh-7rem)]');
    expect(dialog.className).toContain('shadow-[var(--shadow-floating)]');
    expect(body).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto');
    expect(header).toHaveClass('shrink-0');
    expect(footer).toHaveClass('shrink-0');
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
        <SplitButtonMain variant="secondary">Import</SplitButtonMain>
        <SplitButtonToggle variant="secondary" aria-label="Open menu">v</SplitButtonToggle>
        <SplitButtonMenu>
          <SplitButtonMenuItem>Import via AWS SSM</SplitButtonMenuItem>
        </SplitButtonMenu>
      </SplitButton>,
    );

    const importButton = screen.getByRole('button', { name: 'Import' });

    expect(importButton).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open menu' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import via AWS SSM' })).toBeInTheDocument();
    expect(importButton.className).toContain('bg-[var(--surface-elevated)]');
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

  it('renders toolbar and panel section wrappers without legacy utility classes', () => {
    render(
      <Toolbar>
        <PanelSection data-testid="panel-section">
          <Button variant="secondary">Item</Button>
        </PanelSection>
      </Toolbar>,
    );

    expect(screen.getByTestId('panel-section')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Item' })).toBeInTheDocument();
  });

  it('renders field group and filter row wrappers without legacy form shells', () => {
    render(
      <FilterRow>
        <FieldGroup label="Hostname" compact>
          <Input placeholder="example.internal" />
        </FieldGroup>
      </FilterRow>,
    );

    expect(screen.getByText('Hostname')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('example.internal')).toBeInTheDocument();
  });

  it('renders tag input shell with the same focus and sizing contract as standard inputs', () => {
    const onRemoveTag = vi.fn();

    render(
      <TagInputField
        aria-label="Tags"
        tags={['dev']}
        value=""
        placeholder="Type a tag and press Enter"
        onChange={() => undefined}
        onRemoveTag={onRemoveTag}
      />,
    );

    const shell = screen.getByTestId('tag-input-shell');
    const input = screen.getByLabelText('Tags');

    expect(shell.className).toContain('min-h-11');
    expect(shell.className).toContain('border-[var(--border)]');
    expect(shell.className).toContain('focus-within:border-[var(--selection-border)]');
    expect(shell.className).toContain('focus-within:ring-4');
    expect((input as HTMLInputElement).style.all).toBe('unset');
    expect((input as HTMLInputElement).style.caretColor).toBe('var(--accent-strong)');

    fireEvent.mouseDown(shell);
    expect(document.activeElement).toBe(input);

    fireEvent.click(screen.getByRole('button', { name: 'dev 태그 제거' }));
    expect(onRemoveTag).toHaveBeenCalledWith('dev');
  });

  it('renders option card previews and active selection state', () => {
    render(
      <OptionCard
        active
        title="System"
        description="Follow the desktop setting"
        preview={<div data-testid="option-preview">Preview</div>}
      />,
    );

    expect(screen.getByRole('button', { name: /System/i })).toBeInTheDocument();
    expect(screen.getByText('Follow the desktop setting')).toBeInTheDocument();
    expect(screen.getByTestId('option-preview')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /System/i }).className).toContain(
      'bg-[var(--selection-tint)]',
    );
  });

  it('renders toggle switch labels and checked state', () => {
    render(
      <ToggleSwitch
        checked
        aria-label="Follow"
        label="Follow"
        description="Keep the log viewport pinned to the bottom"
      />,
    );

    expect(screen.getByRole('switch', { name: 'Follow' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(
      screen.getByText('Keep the log viewport pinned to the bottom'),
    ).toBeInTheDocument();
  });
});
