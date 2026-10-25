// tailnet 하나를 만들거나 고치는 폼.
//
// 상태를 갖지 않는다 — draft·status·testing·error 는 전부 prop 이고 동작은 콜백이다.
// 그래서 설정 화면(섹션으로)과 호스트 폼의 추가 팝업(모달 안)이 같은 것을 쓸 수 있다.

import { useTranslation } from 'react-i18next';
import type { TailnetStatus } from '@shared';
import { Button, Card, FieldGroup, Input, NoticeCard } from '../../ui';
import { RefreshCw } from '../../ui/icons';
import type { TailnetDraft } from '../../controllers/useTailnetDraft';
import {
  TailnetIdentity,
  TailnetStateBadge,
  TailnetStatusNotice,
} from './TailnetStatusViews';

/**
 * 연결이 확인된 결과. 값이 있으면 붙은 것이고, 그것이 곧 저장 가능 조건이다.
 *
 * 이름이 없을 수도 있어서(컨트롤 플레인이 안 알려 주는 경우) 차례로 물러선다. 붙었는데
 * 이름이 없다는 이유로 저장을 막으면, 멀쩡한 연결을 두고 사용자가 손쓸 방법이 없어진다.
 */
function connectedTailnet(status: TailnetStatus | undefined): string {
  if (status?.state !== 'running') {
    return '';
  }
  return status.tailnetName || status.nodeName || status.loginName || '';
}

export function TailnetForm({
  draft,
  status,
  testing,
  testDisabled,
  error,
  onChange,
  onSave,
  onTest,
  onCancelTest,
  onCancel,
}: {
  draft: TailnetDraft;
  status?: TailnetStatus;
  testing: boolean;
  testDisabled: boolean;
  error?: string | null;
  onChange: (next: TailnetDraft) => void;
  onSave: () => void;
  onTest: () => void;
  onCancelTest: () => void;
  onCancel: () => void;
}) {
  const { t: translate } = useTranslation();
  // 저장된 것을 고치는 중이면 시험하지 않고 저장한다(이유는 TailnetDraft.saved). 그래서 시험 버튼과
  // 그 결과 칸이 없고, 저장이 열려 있다. 붙는지는 저장한 뒤 카드의 연결이나 호스트 연결이 말해 준다.
  const editing = draft.saved !== undefined;
  const connected = connectedTailnet(status);
  const authKeyInput = (
    <>
      <Input
        type="password"
        value={draft.authKey}
        // 고칠 때는 칸이 늘 비어 있다(저장된 키는 내려오지 않는다). 키가 있는데 "비우면 브라우저
        // 로그인" 이라고 하면 비워 둔 채 저장하면 키가 지워지는 것으로 읽힌다.
        placeholder={translate(
          editing && draft.saved?.hasAuthKey
            ? 'hostForm.placeholder.keepBlank'
            : 'tailnetSettings.field.authKeyPlaceholder',
        )}
        onChange={(event) => onChange({ ...draft, authKey: event.target.value })}
      />
      {/* 1회용 키는 첫 재등록에서 막힌다. ephemeral 쪽 결과는 삭제할 때 안내한다. */}
      <span className="text-[0.76rem] font-normal leading-[1.45] text-[var(--text-soft)]">
        {translate('tailnetSettings.field.authKeyHint')}
      </span>
    </>
  );

  return (
    <Card tone="muted" as="section" className="flex-col items-stretch gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <FieldGroup label={translate('tailnetSettings.field.label')}>
          <Input
            value={draft.label}
            placeholder={translate('tailnetSettings.field.labelPlaceholder')}
            onChange={(event) => onChange({ ...draft, label: event.target.value })}
          />
        </FieldGroup>

        <FieldGroup label={translate('tailnetSettings.field.controlUrl')}>
          <Input
            value={draft.controlUrl}
            placeholder={translate('tailnetSettings.field.controlUrlPlaceholder')}
            onChange={(event) => onChange({ ...draft, controlUrl: event.target.value })}
          />
        </FieldGroup>

        {/* 팀 tailnet 도 같은 칸이다. 키는 그 볼트에 두고 팀에는 올리지 않을 뿐이다. */}
        <FieldGroup label={translate('tailnetSettings.field.authKey')}>{authKeyInput}</FieldGroup>
      </div>

      {error ? (
        <NoticeCard tone="danger" role="alert">
          {error}
        </NoticeCard>
      ) : null}

      {/* 편집에서는 그리지 않는다. 이 상태는 저장된 노드의 것이라, 폼 안에 두면 이 폼이 시험한
          결과로 읽힌다. */}
      {status && !editing ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <TailnetStateBadge status={status} />
          </div>
          <TailnetStatusNotice
            controlUrl={draft.controlUrl.trim() || undefined}
            status={status}
          />
        </div>
      ) : null}

      {/* 연결 결과. 손으로 채울 수 없고, 연결에 성공해야 값이 생긴다. 저장 조건이 바로
          이 값이라, 버튼이 왜 안 눌리는지 화면만 보고 알 수 있다. */}
      {editing ? null : (
        <FieldGroup label={translate('tailnetSettings.field.connectedTo')}>
          <Input
            readOnly
            value={connected}
            placeholder={translate('tailnetSettings.field.connectedToPlaceholder')}
            className="cursor-default"
          />
        </FieldGroup>
      )}

      {/* tailnet 이름은 바로 위 읽기 전용 필드에 이미 있다. */}
      {connected && status && !editing ? (
        <TailnetIdentity
          loginName={status.loginName}
          nodeName={status.nodeName}
          nodeIp={status.nodeIp}
        />
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        {/* 저장하기 전에 시험할 수 있어야 한다. 되는지 확인하고 저장하는 게 순서다. */}
        {editing ? null : testing ? (
          <Button variant="secondary" onClick={onCancelTest}>
            <RefreshCw className="h-4 w-4 animate-spin" aria-hidden />
            {translate('tailnetSettings.stopTest')}
          </Button>
        ) : (
          <Button variant="secondary" onClick={onTest} disabled={testDisabled}>
            {translate('tailnetSettings.test')}
          </Button>
        )}
        {/* 시험이 3분까지 갈 수 있다. 여기서 막으면 사용자가 폼에 갇힌다 — 취소는 진행
            중인 시험을 접겠다는 뜻이므로 언제든 눌릴 수 있어야 한다. */}
        <Button variant="secondary" onClick={onCancel}>
          {translate('common.cancel')}
        </Button>
        {/* 붙는 것을 확인하기 전에 저장해 봐야 쓸 수 없는 설정이 하나 늘 뿐이다.
            연결에 성공해야 tailnet 이름 같은 것도 알 수 있다. 편집은 설정을 늘리지 않는다. */}
        <Button
          variant="primary"
          onClick={onSave}
          disabled={!editing && (testing || !connected)}
        >
          {translate('common.save')}
        </Button>
      </div>
    </Card>
  );
}
