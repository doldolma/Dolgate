import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { applyTailnetStatus, forgetTailnetStatus } from '../services/desktop/tailnet-watch';
import {
  cancelTailnet,
  forgetTailnet,
  saveTailnet,
  testTailnet,
} from '../services/desktop/tailnet';
import { useAppStore } from '../store/appStore';
import { normalizeErrorMessage } from '../store/utils/errors-and-prompts';

export interface TailnetDraft {
  id: string;
  label: string;
  controlUrl: string;
  /** 저장할 때만 쓴다. 기존 키는 절대 내려오지 않으므로 빈 값 = "그대로 두기". */
  authKey: string;
}

/**
 * 폼을 열 때 id 를 미리 만든다.
 *
 * 저장 전에 시험할 수 있어야 하는데, 시험은 노드를 만든다. id 를 저장 시점에 만들면 그
 * 노드는 저장될 레코드와 무관한 고아가 된다. 미리 만들어 두면 시험이 올린 노드가 그대로
 * 저장될 레코드의 노드가 되고, 취소하면 그 id 를 등록 해제하면 된다.
 */
export function emptyTailnetDraft(): TailnetDraft {
  return {
    id: crypto.randomUUID(),
    label: '',
    controlUrl: '',
    authKey: '',
  };
}

/**
 * 이름이 비었을 때 대신 쓸 이름.
 *
 * 저장은 연결에 성공한 뒤에만 되므로, 그때는 컨트롤 플레인이 알려 준 tailnet 이름이 있다.
 * 그게 사용자가 직접 지을 이름보다 정확하다. 없으면 서버 주소로 대신한다.
 */
export function deriveTailnetLabel(
  tailnetName: string | undefined,
  controlUrl: string,
): string {
  if (tailnetName) {
    return tailnetName;
  }
  const trimmed = controlUrl.trim();
  if (!trimmed) {
    return 'Tailscale';
  }
  try {
    return new URL(trimmed).host;
  } catch {
    // 주소가 아직 온전하지 않은 경우. 사용자가 적은 것을 그대로 쓴다.
    return trimmed;
  }
}

/**
 * tailnet 초안(연결 시험 → 저장) 컨트롤러.
 *
 * 설정 화면과 호스트 폼의 추가 팝업이 **같은 것을 써야 한다.** 복사하면 두 곳이 갈리고,
 * 갈리는 순간 한쪽이 정리 로직을 잃는다 — 연결 시험은 **진짜 노드를 올리므로**, 저장하지
 * 않고 화면을 떠나면 그 노드가 유령으로 남는다. 그 정리(`forgetTailnet`)가 여기 들어 있다.
 *
 * 오류 상태는 일부러 갖지 않는다. 부르는 쪽이 이미 자기 오류 표시를 갖고 있어서(설정 화면은
 * 삭제·해제 오류와 같은 자리에 띄운다) 여기서 또 만들면 한 화면에 오류 칸이 둘이 된다.
 */
export function useTailnetDraft({
  setError,
}: {
  setError: (message: string | null) => void;
}) {
  const { t: translate } = useTranslation();
  const statusById = useAppStore((state) => state.tailnetStatuses);
  const [draft, setDraft] = useState<TailnetDraft | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  // 시험만 하고 떠난 초안. 언마운트 때 이 노드를 지운다.
  const unsavedDraftIdRef = useRef<string | null>(null);
  // statusById 를 정리 시점에 최신값으로 읽기 위한 거울. effect 의존성에 넣으면 상태가 바뀔
  // 때마다 정리 effect 가 재등록돼 언마운트 정리가 헛돈다.
  const statusRef = useRef(statusById);
  statusRef.current = statusById;

  useEffect(() => {
    return () => {
      const abandoned = unsavedDraftIdRef.current;
      if (abandoned) {
        void forgetTailnet(abandoned).catch(() => {});
      }
    };
  }, []);

  const beginDraft = useCallback(() => {
    setDraft(emptyTailnetDraft());
  }, []);

  /**
   * 연결 시험. 저장된 레코드에도 쓰므로 초안 전용이 아니다 —
   * `isDraft` 일 때만 "저장 없이 떠나면 지울 것" 으로 표시한다.
   */
  const test = useCallback(
    async (config: {
      id: string;
      controlUrl?: string;
      /** 아직 저장하지 않은 초안을 시험할 때만. 저장된 것은 메인이 읽어 넣는다. */
      authKey?: string;
      isDraft?: boolean;
    }) => {
      setError(null);
      setTestingId(config.id);
      if (config.isDraft) {
        unsavedDraftIdRef.current = config.id;
      }
      applyTailnetStatus({ id: config.id, state: 'starting' });
      try {
        const status = await testTailnet({
          id: config.id,
          controlUrl: config.controlUrl,
          authKey: config.authKey,
        });
        applyTailnetStatus(status);
      } catch (cause) {
        applyTailnetStatus({
          id: config.id,
          state: 'stopped',
          error: normalizeErrorMessage(cause, translate('tailnetSettings.unknownError')),
        });
      } finally {
        setTestingId(null);
      }
    },
    [setError, translate],
  );

  /** 진행 중인 연결 시도를 접는다. 코어가 마지막 상태를 보내 주면 화면이 정리된다. */
  const cancelTest = useCallback(
    async (id: string) => {
      try {
        await cancelTailnet(id);
      } catch (cause) {
        setError(normalizeErrorMessage(cause, translate('tailnetSettings.unknownError')));
      }
    },
    [setError, translate],
  );

  /**
   * 초안을 저장한다. 성공하면 저장된 항목을, 실패하면 null 을 준다.
   *
   * id 와 label 을 함께 주는 이유: 호스트 폼의 추가 팝업이 방금 만든 tailnet 을 곧바로 고른
   * 상태로 만들어야 하는데, 상위가 목록을 다시 읽어 내려주기를 기다리면 그 사이 한 프레임
   * 동안 "이 기기에 없는 tailnet" 경고가 번쩍인다. 받은 값으로 항목을 먼저 그리면 그 틈이
   * 없다. (목록을 다시 읽어 마지막 항목을 찍는 식이면 이름이 같은 것이 있을 때 틀린다.)
   */
  const saveDraft = useCallback(async (): Promise<{
    id: string;
    label: string;
  } | null> => {
    if (!draft) {
      return null;
    }
    const status = statusById[draft.id];
    const label =
      draft.label.trim() || deriveTailnetLabel(status?.tailnetName, draft.controlUrl);

    setError(null);
    const now = new Date().toISOString();
    try {
      await saveTailnet({
        record: {
          id: draft.id,
          label,
          controlUrl: draft.controlUrl.trim() || undefined,
          // 연결에 성공해야 저장되므로 여기서는 항상 알 수 있다. 다음 연결 때 이 값과
          // 대조해서, 다른 계정으로 로그인해 다른 tailnet 에 붙은 것을 잡아낸다.
          tailnetName: status?.tailnetName,
          loginName: status?.loginName,
          createdAt: now,
          updatedAt: now,
        },
        // 빈 문자열은 "지우기"라서 그대로 넘기면 안 된다. 손대지 않았으면 생략한다.
        authKey: draft.authKey.length > 0 ? draft.authKey : undefined,
      });
    } catch (cause) {
      setError(normalizeErrorMessage(cause, translate('tailnetSettings.unknownError')));
      return null;
    }
    unsavedDraftIdRef.current = null;
    const saved = { id: draft.id, label };
    setDraft(null);
    return saved;
  }, [draft, setError, statusById, translate]);

  /** 저장하지 않고 닫으면 시험이 올린 노드가 남는다. 그것부터 지운다. */
  const discardDraft = useCallback(async () => {
    const abandoned = draft;
    unsavedDraftIdRef.current = null;
    setDraft(null);
    setError(null);
    if (!abandoned || !statusRef.current[abandoned.id]) {
      return;
    }
    forgetTailnetStatus(abandoned.id);
    try {
      await forgetTailnet(abandoned.id);
    } catch {
      // 노드가 없거나 컨트롤 플레인에 닿지 못한 경우. 폼을 닫는 것까지 막을 이유는 없다.
    }
  }, [draft, setError]);

  return {
    draft,
    setDraft,
    beginDraft,
    testingId,
    test,
    cancelTest,
    saveDraft,
    discardDraft,
  };
}
