import React from "react";
import { useTranslation } from "react-i18next";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import Ionicons from "react-native-vector-icons/Ionicons";
import {
  getHostSubtitle,
  type HostRecord,
  isAwsEc2HostRecord,
  isSshHostRecord,
} from "@dolssh/shared-core";
import { useMobilePalette } from "../theme";
import { getAwsEc2SftpDisabledMessage, hostSubtitleLabels } from '../i18n/shared-messages';

interface HostActionSheetProps {
  host: HostRecord | null;
  onClose: () => void;
  onConnect: (host: HostRecord) => void;
  onConnectSftp: (host: HostRecord) => void;
  onEdit: (host: HostRecord) => void;
  onDelete: (host: HostRecord) => void;
}

interface SheetAction {
  key: string;
  icon: string;
  label: string;
  danger?: boolean;
  disabledReason?: string | null;
  onPress: () => void;
}

// 호스트 롱터치 액션 시트. 수정·삭제는 모바일이 관리하는 SSH 호스트에만 노출한다 —
// AWS 호스트는 데스크톱 디스커버리가 관리하므로 연결·SFTP 만 제공한다.
export function HostActionSheet({
  host,
  onClose,
  onConnect,
  onConnectSftp,
  onEdit,
  onDelete,
}: HostActionSheetProps): React.JSX.Element {
  const palette = useMobilePalette();
  const { t: translate } = useTranslation();

  const actions: SheetAction[] = [];
  if (host) {
    const sftpDisabledReason = isAwsEc2HostRecord(host)
      ? getAwsEc2SftpDisabledMessage(host)
      : null;

    actions.push({
      key: "connect",
      icon: "flash-outline",
      label: translate("hostActions.connect"),
      onPress: () => onConnect(host),
    });
    actions.push({
      key: "sftp",
      icon: "folder-open-outline",
      label: translate("hostActions.sftp"),
      disabledReason: sftpDisabledReason,
      onPress: () => onConnectSftp(host),
    });
    if (isSshHostRecord(host)) {
      actions.push({
        key: "edit",
        icon: "create-outline",
        label: translate("common.edit"),
        onPress: () => onEdit(host),
      });
      actions.push({
        key: "delete",
        icon: "trash-outline",
        label: translate("common.delete"),
        danger: true,
        onPress: () => onDelete(host),
      });
    }
  }

  return (
    <Modal
      visible={host !== null}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        style={styles.backdrop}
        accessibilityLabel={translate("hostActions.closeAria")}
        onPress={onClose}
      >
        <Pressable
          style={[
            styles.sheet,
            {
              backgroundColor: palette.surface,
              borderColor: palette.border,
            },
          ]}
          onPress={(event) => event.stopPropagation()}
        >
          {host ? (
            <View style={styles.header}>
              <Text
                numberOfLines={1}
                style={[styles.title, { color: palette.text }]}
              >
                {host.label}
              </Text>
              <Text
                numberOfLines={1}
                style={[styles.subtitle, { color: palette.mutedText }]}
              >
                {getHostSubtitle(host, hostSubtitleLabels())}
              </Text>
            </View>
          ) : null}
          {actions.map((action) => {
            const disabled = Boolean(action.disabledReason);
            const color = action.danger
              ? palette.danger
              : disabled
                ? palette.mutedText
                : palette.text;
            return (
              <Pressable
                key={action.key}
                accessibilityRole="button"
                accessibilityLabel={action.label}
                disabled={disabled}
                onPress={action.onPress}
                style={[
                  styles.actionRow,
                  { borderTopColor: palette.border },
                  disabled ? styles.actionRowDisabled : null,
                ]}
              >
                <Ionicons name={action.icon} size={20} color={color} />
                <View style={styles.actionCopy}>
                  <Text style={[styles.actionLabel, { color }]}>
                    {action.label}
                  </Text>
                  {action.disabledReason ? (
                    <Text
                      style={[
                        styles.actionReason,
                        { color: palette.mutedText },
                      ]}
                    >
                      {action.disabledReason}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            );
          })}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(8, 12, 22, 0.55)",
    justifyContent: "flex-end",
    padding: 14,
  },
  sheet: {
    borderWidth: 1,
    borderRadius: 22,
    paddingBottom: 8,
    overflow: "hidden",
  },
  header: {
    paddingHorizontal: 18,
    paddingVertical: 14,
    gap: 3,
  },
  title: {
    fontSize: 16,
    fontWeight: "800",
  },
  subtitle: {
    fontSize: 12,
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderTopWidth: 1,
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  actionRowDisabled: {
    opacity: 0.55,
  },
  actionCopy: {
    flex: 1,
    gap: 2,
  },
  actionLabel: {
    fontSize: 15,
    fontWeight: "700",
  },
  actionReason: {
    fontSize: 11,
    lineHeight: 15,
  },
});
