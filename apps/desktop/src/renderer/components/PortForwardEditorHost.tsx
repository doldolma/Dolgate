// 포트 포워딩 편집기를 앱 전체에 하나만 띄우는 자리.
//
// **왜 별도 컴포넌트인가.** 편집기 본체는 PortForwardingPanel 이고, 그것은 목록 화면이 쓰는
// props 17개를 받는다. 그 값이 전부 스토어에서 오므로 여기서 한 번 읽어 넘긴다 — AppModals 를
// 지나 흘리면 편집기를 열 자리가 늘어날 때마다 props 사슬을 늘려야 한다.
//
// **의도가 없으면 아무것도 마운트하지 않는다.** 편집기는 컨테이너·ECS 탐색까지 이고 있어서,
// 닫혀 있는 동안 세워 두면 그 구독이 계속 돈다.

import { useMemo } from 'react';
import { useAppStore } from '../store/appStore';
import { PortForwardingPanel } from './PortForwardingPanel';

export function PortForwardEditorHost() {
  const intent = useAppStore((state) => state.portForwardEditor);
  const hosts = useAppStore((state) => state.hosts);
  const containerTabs = useAppStore((state) => state.containerTabs);
  const rules = useAppStore((state) => state.portForwards);
  const dnsOverrides = useAppStore((state) => state.dnsOverrides);
  const runtimes = useAppStore((state) => state.portForwardRuntimes);
  const pendingInteractiveAuths = useAppStore((state) => state.pendingInteractiveAuths);
  const savePortForward = useAppStore((state) => state.savePortForward);
  const saveDnsOverride = useAppStore((state) => state.saveDnsOverride);
  const setStaticDnsOverrideActive = useAppStore((state) => state.setStaticDnsOverrideActive);
  const removePortForward = useAppStore((state) => state.removePortForward);
  const removeDnsOverride = useAppStore((state) => state.removeDnsOverride);
  const startPortForward = useAppStore((state) => state.startPortForward);
  const stopPortForward = useAppStore((state) => state.stopPortForward);
  const respondInteractiveAuth = useAppStore((state) => state.respondInteractiveAuth);
  const reopenInteractiveAuthUrl = useAppStore((state) => state.reopenInteractiveAuthUrl);
  const clearPendingInteractiveAuth = useAppStore((state) => state.clearPendingInteractiveAuth);

  // 화면 쪽과 같은 규칙으로 고른다(HomeShell 의 필터와 동일) — 다른 기준을 쓰면 같은 프롬프트가
  // 한쪽에만 뜬다.
  const interactiveAuth = useMemo(
    () => pendingInteractiveAuths.find((auth) => auth.source === 'portForward') ?? null,
    [pendingInteractiveAuths],
  );
  const discoveryInteractiveAuth = useMemo(
    () => pendingInteractiveAuths.find((auth) => auth.source === 'containers') ?? null,
    [pendingInteractiveAuths],
  );

  if (!intent) {
    return null;
  }

  return (
    <PortForwardingPanel
      variant="dialog"
      hosts={hosts}
      containerTabs={containerTabs}
      rules={rules}
      dnsOverrides={dnsOverrides}
      runtimes={runtimes}
      interactiveAuth={interactiveAuth}
      discoveryInteractiveAuth={discoveryInteractiveAuth}
      onSave={savePortForward}
      onSaveDnsOverride={saveDnsOverride}
      onSetStaticDnsOverrideActive={setStaticDnsOverrideActive}
      onRemove={removePortForward}
      onRemoveDnsOverride={removeDnsOverride}
      onStart={startPortForward}
      onStop={stopPortForward}
      onRespondInteractiveAuth={respondInteractiveAuth}
      onReopenInteractiveAuthUrl={reopenInteractiveAuthUrl}
      onClearInteractiveAuth={clearPendingInteractiveAuth}
    />
  );
}
