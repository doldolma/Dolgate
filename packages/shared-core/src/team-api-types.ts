import type { SyncRecord } from "./api";
import { normalizeTeamRole, type TeamRole } from "./team-roles";

/*
 * 팀 동기화 API 의 응답 모양(services/sync-api 의 http/teams.go). 데스크톱과 모바일이 같은 것으로 읽는다.
 */

/** 팀 목록의 한 줄(GET /teams). */
export interface TeamSummary {
  id: string;
  name: string;
  role: TeamRole;
  /** 내 개인 DEK 로 감싼 팀 키. 링크로 들어와 아직 올리지 않았으면 null. */
  wrappedTeamDek: string | null;
  dataFloor: number;
  memberCount: number;
  createdAt: string;
}

/** 서버가 보내는 팀 목록 한 줄 그대로. 옛 서버에는 빠진 칸이 있다. */
export interface RawTeamSummary {
  id: string;
  name: string;
  role: string;
  wrappedTeamDek?: string | null;
  dataFloor?: number;
  memberCount?: number;
  createdAt?: string;
}

export function toTeamSummary(raw: RawTeamSummary): TeamSummary {
  return {
    id: raw.id,
    name: raw.name,
    role: normalizeTeamRole(raw.role),
    // 사본을 아직 안 올린 멤버는 빈 문자열로 온다.
    wrappedTeamDek: raw.wrappedTeamDek ? raw.wrappedTeamDek : null,
    dataFloor: typeof raw.dataFloor === "number" ? raw.dataFloor : 0,
    memberCount: typeof raw.memberCount === "number" ? raw.memberCount : 0,
    createdAt: raw.createdAt ?? "",
  };
}

/** 종류 → 레코드. 개인 /sync 와 같은 모양이다. */
export type TeamSyncPayload = Record<string, SyncRecord[]>;

/** 팀 감시(GET /teams/:id/sync/watch)가 주는 리비전 — 레코드·팀 정보(이름·역할·키)·내 개인 칸. */
export interface TeamWatchRevisions {
  revision: number;
  infoRevision: number;
  privateRevision: number;
}

export type TeamWatchResult =
  | { changed: false }
  | { changed: true; etag: string | null; revisions: TeamWatchRevisions };
