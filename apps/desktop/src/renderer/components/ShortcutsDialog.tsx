import { DialogBackdrop } from './DialogBackdrop';
import { ModalBody, ModalHeader, ModalShell, SectionLabel } from '../ui';

interface ShortcutsDialogProps {
  open: boolean;
  onClose: () => void;
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

export function ShortcutsDialog({ open, onClose }: ShortcutsDialogProps) {
  if (!open) {
    return null;
  }
  const mac = isMacPlatform();
  const cmd = mac ? '⌘' : 'Ctrl';
  const shift = mac ? '⇧' : 'Shift';
  const sections: ShortcutSection[] = [
    {
      title: '일반',
      items: [
        { label: '새 창', keys: [cmd, 'N'] },
        { label: '호스트 검색', keys: [cmd, 'K'] },
        { label: '검색 / 찾기', keys: [cmd, 'F'] },
      ],
    },
    {
      title: '탭',
      items: [
        { label: '다음 탭', keys: mac ? ['⌘', '⌥', '→'] : ['Ctrl', 'Tab'] },
        { label: '이전 탭', keys: mac ? ['⌘', '⌥', '←'] : ['Ctrl', 'Shift', 'Tab'] },
        { label: '1~8번째 탭', keys: [cmd, '1…8'] },
        { label: '마지막 탭', keys: [cmd, '9'] },
        { label: '닫은 탭 다시 열기', keys: [cmd, shift, 'T'] },
        { label: '탭 닫기', keys: [cmd, 'W'] },
      ],
    },
    {
      title: 'tmux',
      items: [{ label: 'tmux 프리픽스', keys: ['Ctrl', 'B'] }],
    },
  ];
  return (
    <DialogBackdrop onDismiss={onClose}>
      <ModalShell role="dialog" aria-modal="true" aria-labelledby="shortcuts-dialog-title">
        <ModalHeader className="block">
          <SectionLabel>도움말</SectionLabel>
          <h3 id="shortcuts-dialog-title">키보드 단축키</h3>
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
        </ModalBody>
      </ModalShell>
    </DialogBackdrop>
  );
}
