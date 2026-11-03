import type { TeamVaultResetItem } from "@shared";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listTeamsLeftOnVaultReset } from "../services/desktop/auth-window-updater";

/**
 * 동기화 암호 초기화·회원 탈퇴 확인 창의 팀 안내. 둘 다 서버가 그 사람을 모든 팀에서 빼고, 혼자인 팀은 서버에서도 지운다 — 팀이
 * 있을 때만 보인다. 첫 문장만 창마다 다르다(탈퇴는 계정이 없어지니 다시 들어오기를 말하지 않는다). 서버 목록을 못 읽었으면
 * 혼자인 팀을 이름 대신 한 문장으로 알린다. 창이 열릴 때 그린다(그때 묻는다).
 */
export function VaultResetTeamsNote({
  className,
  kind = "vaultReset",
}: {
  className?: string;
  kind?: "vaultReset" | "accountDelete";
}) {
  const { t: translate } = useTranslation();
  const [teams, setTeams] = useState<TeamVaultResetItem[]>([]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const items = await listTeamsLeftOnVaultReset();
        if (active && Array.isArray(items)) {
          setTeams(items);
        }
      } catch {
        // 못 읽으면 안내 없이 둔다 — 초기화·탈퇴를 막을 일은 아니다.
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  if (teams.length === 0) {
    return null;
  }
  const soleNames = teams.filter((team) => team.soleMember === true).map((team) => team.name);
  const soleUnknown = teams.some((team) => team.soleMember === null);
  return (
    <p className={className}>
      {translate(kind === "accountDelete" ? "settings.deleteAccount.teamsLeave" : "vaultGate.reset.teamsLeave", {
        count: teams.length,
        names: teams.map((team) => team.name).join(", "),
      })}
      {soleNames.length > 0
        ? ` ${translate("vaultGate.reset.teamsSoleDeleted", { names: soleNames.join(", ") })}`
        : soleUnknown
          ? ` ${translate("vaultGate.reset.teamsSoleMaybe")}`
          : null}
    </p>
  );
}
