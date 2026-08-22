import React from "react";
import { useTranslation } from "react-i18next";
import {
  getHostSubtitle,
  type HostRecord,
  isAwsEc2HostRecord,
  isRdpHostRecord,
  isSshHostRecord,
  isVncHostRecord,
} from "@dolssh/shared-core";
import { ActionSheet, type ActionSheetItem } from "./ActionSheet";
import { getAwsEc2SftpDisabledMessage, hostSubtitleLabels } from '../i18n/shared-messages';

interface HostActionSheetProps {
  host: HostRecord | null;
  onClose: () => void;
  onConnect: (host: HostRecord) => void;
  onConnectSftp: (host: HostRecord) => void;
  onEdit: (host: HostRecord) => void;
  onDelete: (host: HostRecord) => void;
  onToggleFavorite: (host: HostRecord) => void;
}

// 호스트 롱터치 액션 시트.
//
// 삭제는 모바일이 관리하는 SSH 호스트에만 노출한다 — AWS 호스트는 디스커버리가 관리하므로 여기서
// 지울 것이 아니다. 반면 **편집은 EC2 에도 준다**: 인스턴스 정보는 못 고치지만 접속 경로(서버
// 프록시)는 기기 사정에 따라 달라지고, 그것을 폰에서 못 바꾸면 직접 접속과 서버 경유를 고를 수
// 없다(그 화면이 무엇을 보여주는지는 HostFormScreen 의 AwsEc2HostForm 참고).
export function HostActionSheet({
  host,
  onClose,
  onConnect,
  onConnectSftp,
  onEdit,
  onDelete,
  onToggleFavorite,
}: HostActionSheetProps): React.JSX.Element {
  const { t: translate } = useTranslation();

  const actions: ActionSheetItem[] = [];
  if (host) {
    const isRdHost = isRdpHostRecord(host) || isVncHostRecord(host);
    const sftpDisabledReason = isAwsEc2HostRecord(host)
      ? getAwsEc2SftpDisabledMessage(host)
      : null;

    actions.push({
      key: "connect",
      icon: isRdHost ? "desktop-outline" : "flash-outline",
      label: translate("hostActions.connect"),
      onPress: () => onConnect(host),
    });
    // SFTP is not applicable to RDP/VNC hosts.
    if (!isRdHost) {
      actions.push({
        key: "sftp",
        icon: "folder-open-outline",
        label: translate("hostActions.sftp"),
        disabledReason: sftpDisabledReason,
        onPress: () => onConnectSftp(host),
      });
    }
    const isFavorite = host.favorite === true;
    actions.push({
      key: "favorite",
      icon: isFavorite ? "star" : "star-outline",
      label: translate(
        isFavorite ? "hostActions.favoriteRemove" : "hostActions.favoriteAdd",
      ),
      onPress: () => onToggleFavorite(host),
    });
    if (isSshHostRecord(host) || isAwsEc2HostRecord(host)) {
      actions.push({
        key: "edit",
        icon: "create-outline",
        label: translate("common.edit"),
        onPress: () => onEdit(host),
      });
    }
    if (isSshHostRecord(host)) {
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
    <ActionSheet
      visible={host !== null}
      closeAccessibilityLabel={translate("hostActions.closeAria")}
      title={host?.label ?? null}
      subtitle={host ? getHostSubtitle(host, hostSubtitleLabels()) : null}
      items={actions}
      onClose={onClose}
    />
  );
}

