// 보조 채널에서 명령을 돌릴 때 앞에 붙이는 PATH.
//
// 보조 채널은 **로그인 셸이 아니다**(sshd 의 exec 채널은 `sh -s` 로 뜨고 프로필을 읽지 않는다).
// 그래서 PATH 가 최소한이고, 사용자가 대화형으로 쓰는 도구가 대개 빠진다 — snap 으로 깐 docker
// (`/snap/bin`), `/usr/local/bin`, `~/.local/bin` 이 그렇다. 터미널에서는 되는데 우리 왕복에서만
// "없는 것" 이 되는 이유가 이것이다.
//
// 프로필을 읽지 않고 PATH 만 넓힌다 — 프로필을 source 하면 그 출력(motd·echo)이 stdout 에 섞여
// 파싱이 깨진다. `$HOME`·`$PATH` 는 원격 셸이 펼친다.
const EXTRA_PATH = '/usr/local/bin:/usr/local/sbin:/snap/bin:$HOME/.local/bin:$HOME/bin';

/** 명령 하나 앞에 붙이는 형태(`PATH=… cmd`). */
export const AUX_PATH_ASSIGNMENT = `PATH="$PATH:${EXTRA_PATH}"`;

/** 여러 명령을 `;` 로 잇는 줄 앞에 붙이는 형태 — 한 명령에만 걸리면 뒤가 다시 좁아진다. */
export const AUX_PATH_EXPORT = `export ${AUX_PATH_ASSIGNMENT}; `;
