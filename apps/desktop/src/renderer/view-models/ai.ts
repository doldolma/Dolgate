import { useAppStore } from '../store/appStore';

// App.tsx가 DesktopEventBridge에 넘길 AI 스트리밍 이벤트 핸들러.
// 패널 컴포넌트 자체는 useAppStore로 상태·액션을 직접 구독한다(다른 terminal-workspace 컴포넌트와 동일).
export function useAiChatViewModel() {
  const handleAiChatEvent = useAppStore((state) => state.handleAiChatEvent);
  return { handleAiChatEvent };
}
