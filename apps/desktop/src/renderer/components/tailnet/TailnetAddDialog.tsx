import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ModalBody, ModalHeader, ModalShell, SectionLabel } from '../../ui';
import { DialogBackdrop } from '../DialogBackdrop';
import { useAppStore } from '../../store/appStore';
import { useTailnetDraft } from '../../controllers/useTailnetDraft';
import { TailnetForm } from './TailnetForm';

/**
 * 호스트 폼에서 tailnet 을 바로 추가하는 팝업.
 *
 * 설정 화면으로 나갔다 돌아오지 않고 그 자리에서 만들고, 만든 것이 곧바로 그 호스트에
 * 선택된다. 폼과 컨트롤러는 설정 화면과 **같은 것**을 쓴다 — 복사하면 한쪽이 미저장 노드
 * 정리를 잃고, 시험만 하고 닫았을 때 노드가 유령으로 남는다.
 *
 * 여기서 만들기만 한다. 이름 변경·삭제는 설정 화면에 남는다 — 호스트를 고치다 말고 할 일이
 * 아니고, 삭제는 그 tailnet 을 쓰는 다른 호스트까지 건드린다.
 */
export function TailnetAddDialog({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  /** 저장된 tailnet. 호스트 폼이 이 값을 곧바로 목록에 넣고 선택한다. */
  onAdded: (tailnet: { id: string; label: string }) => void | Promise<void>;
}) {
  const { t: translate } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const statusById = useAppStore((state) => state.tailnetStatuses);
  const {
    draft,
    setDraft,
    beginDraft,
    testingId,
    test,
    cancelTest,
    saveDraft,
    discardDraft,
  } = useTailnetDraft({ setError });

  // 팝업이 열리는 순간 초안이 하나 있어야 한다. 설정 화면은 "추가" 버튼을 눌러 초안을
  // 만들지만, 여기서는 팝업이 열린 것 자체가 그 버튼을 누른 것이다.
  useEffect(() => {
    beginDraft();
  }, [beginDraft]);

  const current = draft;
  const testing = current !== null && testingId === current.id;

  const close = () => {
    void discardDraft();
    onClose();
  };

  return (
    <DialogBackdrop
      // 시험 중에는 배경 클릭으로 닫히지 않게 한다. 시험은 진짜 노드를 올리고 브라우저
      // 로그인까지 다녀오는 일이라 3분까지 걸릴 수 있는데, 그 사이 실수로 배경을 누르면
      // 여태 한 것이 사라진다. **취소 버튼은 그대로 살아 있다** — 폼 안에 있고, 누르면
      // 진행 중인 시험을 접고 올라간 노드까지 치운다.
      dismissDisabled={testing}
      onDismiss={close}
    >
      <ModalShell role="dialog" aria-modal="true" aria-labelledby="tailnet-add-title" size="lg">
        <ModalHeader>
          <div>
            <SectionLabel>Tailnet</SectionLabel>
            <h3 id="tailnet-add-title">{translate('tailnetSettings.addTitle')}</h3>
          </div>
        </ModalHeader>
        <ModalBody>
          {current ? (
            <TailnetForm
              draft={current}
              status={statusById[current.id]}
              testing={testing}
              testDisabled={testingId !== null}
              error={error}
              onChange={setDraft}
              onSave={() => {
                void (async () => {
                  const saved = await saveDraft();
                  if (!saved) {
                    return;
                  }
                  await onAdded(saved);
                  onClose();
                })();
              }}
              onTest={() =>
                void test({
                  id: current.id,
                  controlUrl: current.controlUrl.trim() || undefined,
                  authKey: current.authKey.trim() || undefined,
                  isDraft: true,
                })
              }
              onCancelTest={() => void cancelTest(current.id)}
              onCancel={close}
            />
          ) : null}
        </ModalBody>
      </ModalShell>
    </DialogBackdrop>
  );
}
