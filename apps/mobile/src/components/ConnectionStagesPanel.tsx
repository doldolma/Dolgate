import React from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import {
  describeConnectionStage,
  describeStageGroup,
  type ConnectionStage,
} from "../lib/connection-stages";
import { useMobilePalette } from "../theme";

interface ConnectionStagesPanelProps {
  title: string;
  stages: readonly ConnectionStage[];
  /** 아직 붙는 중인지. 끝난 뒤에도 실패한 단계를 남겨 보여주므로 따로 받는다. */
  busy: boolean;
}

/**
 * 연결이 어디까지 갔는지 보여준다.
 *
 * 예전에는 한 줄 문구였다("Tailnet 연결 중…"). 새 단계가 앞 단계를 덮어써서 지나간 것은 사라지고,
 * 실패했을 때 tailnet 때문인지 SSH 가 거절한 것인지 알 수 없었다 — 데스크톱이 이것을 단계 목록으로
 * 바꾼 이유이고, 계산은 shared-core 가 두 앱에 같은 것을 준다.
 */
export function ConnectionStagesPanel({
  title,
  stages,
  busy,
}: ConnectionStagesPanelProps): React.JSX.Element | null {
  const palette = useMobilePalette();
  if (stages.length === 0) {
    return null;
  }

  const failed = stages.some(stage => stage.state === "failed");
  let lastGroup: ConnectionStage["group"] | null = null;

  return (
    <View
      style={[
        styles.panel,
        {
          backgroundColor: palette.surface,
          borderColor: failed
            ? palette.sessionStatusError
            : palette.sessionStatusWarning,
        },
      ]}
    >
      <View style={styles.header}>
        {busy ? <ActivityIndicator size="small" color={palette.accent} /> : null}
        <Text style={[styles.title, { color: palette.text }]}>{title}</Text>
      </View>

      {stages.map(stage => {
        const described = describeConnectionStage(stage);
        const groupChanged = stage.group !== lastGroup;
        lastGroup = stage.group;
        return (
          <View key={stage.id}>
            {groupChanged ? (
              <Text style={[styles.group, { color: palette.mutedText }]}>
                {describeStageGroup(stage.group)}
              </Text>
            ) : null}
            <View style={styles.stageRow}>
              <Text style={[styles.mark, { color: stageColor(stage, palette) }]}>
                {STAGE_MARK[stage.state]}
              </Text>
              <View style={styles.stageCopy}>
                <Text style={[styles.stageLabel, { color: stageColor(stage, palette) }]}>
                  {described.label}
                </Text>
                {described.detail ? (
                  <Text style={[styles.stageDetail, { color: palette.mutedText }]}>
                    {described.detail}
                  </Text>
                ) : null}
              </View>
            </View>
          </View>
        );
      })}

    </View>
  );
}

/** 상태를 한 글자로. 화면이 좁아 아이콘 대신 이 표시를 쓴다. */
const STAGE_MARK: Record<ConnectionStage["state"], string> = {
  pending: "·",
  active: "…",
  // 사람이 무언가 해야 진행되는 단계. 기다림(…)과 구분되어야 사용자가 자기 차례임을 안다.
  blocked: "!",
  done: "✓",
  failed: "✕",
  warn: "!",
};

function stageColor(
  stage: ConnectionStage,
  palette: ReturnType<typeof useMobilePalette>,
): string {
  switch (stage.state) {
    case "done":
      return palette.sessionStatusConnected;
    case "failed":
      return palette.sessionStatusError;
    case "blocked":
    case "warn":
      return palette.sessionStatusWarning;
    case "pending":
      return palette.mutedText;
    default:
      return palette.text;
  }
}

const styles = StyleSheet.create({
  panel: {
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginHorizontal: 4,
    gap: 6,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  title: {
    fontSize: 15,
    fontWeight: "700",
    flex: 1,
  },
  group: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    marginTop: 6,
  },
  stageRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingVertical: 1,
  },
  mark: {
    width: 14,
    textAlign: "center",
    fontSize: 13,
    fontWeight: "700",
  },
  stageCopy: {
    flex: 1,
    gap: 1,
  },
  stageLabel: {
    fontSize: 13,
  },
  stageDetail: {
    fontSize: 11,
    lineHeight: 16,
  },
});
