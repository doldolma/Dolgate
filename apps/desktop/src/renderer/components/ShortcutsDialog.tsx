import { DialogBackdrop } from './DialogBackdrop';
import { ModalBody, ModalHeader, ModalShell, SectionLabel } from '../ui';
import { tmuxPrefixKeyLabels } from '../lib/tmux-prefix';
import { useTranslation } from 'react-i18next';

interface ShortcutsDialogProps {
  open: boolean;
  onClose: () => void;
  /** 설정된 tmux 프리픽스("C-b" 등). 없으면 기본 Ctrl-B 로 안내한다. */
  tmuxPrefixKey?: string;
}

// 플랫폼은 앱이 documentElement.dataset.platform 에 심어두며(NetworkBridge 참고),
// 없으면 navigator로 추정한다. mac 은 기호(⌘/⌥/⇧), 그 외는 글자(Ctrl/Alt/Shift)로 표기.
function isMacPlatform(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.dataset.platform) {
    return document.documentElement.dataset.platform === 'darwin';
  }
  return typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
}

interface ShortcutSection {
  title: string;
  items: Array<{ label: string; keys: string[] }>;
}

export function ShortcutsDialog({
  open,
  onClose,
  tmuxPrefixKey,
}: ShortcutsDialogProps) {
  const { t: translate } = useTranslation();
  if (!open) {
    return null;
  }
  const mac = isMacPlatform();
  const cmd = mac ? '⌘' : 'Ctrl';
  const shift = mac ? '⇧' : 'Shift';
  const sections: ShortcutSection[] = [
    {
      title: translate('shortcuts.group.general'),
      items: [
        { label: translate('shortcuts.item.newWindow'), keys: [cmd, 'N'] },
        { label: translate('shortcuts.item.searchHosts'), keys: [cmd, 'K'] },
        { label: translate('shortcuts.item.find'), keys: [cmd, 'F'] },
      ],
    },
    {
      title: translate('shortcuts.group.tabs'),
      items: [
        { label: translate('shortcuts.item.newTab'), keys: [cmd, 'T'] },
        { label: translate('shortcuts.item.nextTab'), keys: mac ? ['⌘', '⌥', '→'] : ['Ctrl', 'Tab'] },
        { label: translate('shortcuts.item.prevTab'), keys: mac ? ['⌘', '⌥', '←'] : ['Ctrl', 'Shift', 'Tab'] },
        { label: translate('shortcuts.item.tab1to8'), keys: [cmd, '1…8'] },
        { label: translate('shortcuts.item.lastTab'), keys: [cmd, '9'] },
        { label: translate('shortcuts.item.reopenTab'), keys: [cmd, shift, 'T'] },
        { label: translate('shortcuts.item.closeTab'), keys: [cmd, 'W'] },
      ],
    },
    {
      title: translate('shortcuts.group.terminal'),
      items: [
        { label: translate('shortcuts.item.commandPalette'), keys: [cmd, shift, 'P'] },
        { label: translate('shortcuts.item.aiAssistant'), keys: [cmd, 'I'] },
        { label: translate('shortcuts.item.prevNextCommand'), keys: [cmd, '↑ / ↓'] },
        { label: translate('shortcuts.item.prevNextFailed'), keys: [cmd, shift, '↑ / ↓'] },
      ],
    },
    {
      title: 'tmux',
      items: [
        { label: translate('shortcuts.item.tmuxPrefix'), keys: tmuxPrefixKeyLabels(tmuxPrefixKey) },
      ],
    },
  ];
  return (
    <DialogBackdrop onDismiss={onClose}>
      <ModalShell role="dialog" aria-modal="true" aria-labelledby="shortcuts-dialog-title">
        <ModalHeader className="block">
          <SectionLabel>{translate('shortcuts.help')}</SectionLabel>
          <h3 id="shortcuts-dialog-title">{translate('shortcuts.title')}</h3>
        </ModalHeader>
        <ModalBody className="grid gap-[1.1rem]">
          {sections.map((section) => (
            <div key={section.title} className="grid gap-[0.35rem]">
              <span className="text-[0.72rem] font-bold uppercase tracking-[0.12em] text-[var(--text-soft)]">
                {section.title}
              </span>
              {section.items.map((item) => (
                <div
                  key={item.label}
                  className="flex items-center justify-between gap-4 py-[0.15rem]"
                >
                  <span className="text-[0.85rem] text-[var(--text)]">{item.label}</span>
                  <span className="flex shrink-0 items-center gap-[0.25rem]">
                    {item.keys.map((key, index) => (
                      <kbd
                        key={index}
                        className="inline-flex min-w-[1.5rem] items-center justify-center rounded-[6px] border border-[var(--border)] bg-[var(--surface-muted)] px-[0.45rem] py-[0.15rem] font-mono text-[0.75rem] text-[var(--text-soft)]"
                      >
                        {key}
                      </kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          ))}
          <p className="m-0 text-[0.72rem] leading-[1.5] text-[var(--text-soft)]">
            {translate('shortcuts.note')}
          </p>
        </ModalBody>
      </ModalShell>
    </DialogBackdrop>
  );
}
