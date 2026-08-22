import React from "react";
import { useTranslation } from "react-i18next";
import type { GroupCardView } from "@dolssh/shared-core";
import { ActionSheet } from "./ActionSheet";

interface GroupActionSheetProps {
  group: GroupCardView | null;
  onClose: () => void;
  onRename: (group: GroupCardView) => void;
  onDelete: (group: GroupCardView) => void;
  /** 시트가 사라진 뒤(iOS). 이름 입력 모달이 이 신호를 기다린다 — ActionSheet 주석 참고. */
  onDismissed?: () => void;
}

// 그룹 롱터치 액션 시트.
//
// 이동(move)은 넣지 않았다. 목적지를 고르는 화면이 따로 필요한데 폰에서 트리를 옮기는 일이
// 흔치 않다. 필요해지면 그때 만든다.
export function GroupActionSheet({
  group,
  onClose,
  onRename,
  onDelete,
  onDismissed,
}: GroupActionSheetProps): React.JSX.Element {
  const { t: translate } = useTranslation();

  return (
    <ActionSheet
      visible={group !== null}
      closeAccessibilityLabel={translate("groupActions.closeAria")}
      title={group?.name ?? null}
      subtitle={
        group
          ? translate("groupActions.hostCount", { count: group.hostCount })
          : null
      }
      items={
        group
          ? [
              {
                key: "rename",
                icon: "create-outline",
                label: translate("groupActions.rename"),
                onPress: () => onRename(group),
              },
              {
                key: "delete",
                icon: "trash-outline",
                label: translate("groupActions.delete"),
                danger: true,
                onPress: () => onDelete(group),
              },
            ]
          : []
      }
      onClose={onClose}
      onDismissed={onDismissed}
    />
  );
}
