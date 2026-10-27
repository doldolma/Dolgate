import { User } from '../../ui/icons';

/** 기록 카드의 누가 한 줄 — 팀 기록과 바뀐 것이 같은 모양으로 쓴다. */
export function AuthorLine({ email }: { email: string }) {
  return (
    <div className="mt-[0.15rem] flex min-w-0 items-center gap-[0.3rem] text-[0.82rem] text-[var(--text-soft)]">
      <User className="h-[0.8rem] w-[0.8rem] shrink-0" aria-hidden />
      <span className="truncate">{email}</span>
    </div>
  );
}
