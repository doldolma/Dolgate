// 복원 바이트를 진짜 터미널 에뮬레이터(xterm.js)에 먹여 사용자가 보게 될 화면을 뽑는다.
//
// 왜 필요한가. 지금까지 두 번, Go 쪽 단위 테스트를 통과시킨 코드가 실기기에서 화면을
// 망가뜨렸다. Go 테스트는 "우리가 만든 바이트" 만 보고, 그 바이트가 터미널에서 **무엇이
// 되는지** 는 보지 않기 때문이다. 이 스크립트가 그 빈 곳을 메운다: 데스크톱 렌더러가 쓰는
// 것과 같은 xterm.js 로 화면을 만들고 텍스트로 덤프한다.
//
// 사용: node render-screen.cjs <바이트파일> <cols> <rows> [<처음cols> <처음rows>]
//   뒤의 두 인자를 주면 **그 크기의 xterm 에 먼저 재생한 뒤** cols x rows 로 리사이즈한다 —
//   렌더러의 xterm 이 씨앗 크기(120x32)일 때 바이트가 도착하고 나중에 실제 크기로 맞춰지는
//   경로를 그대로 흉내 낸다.
// 출력: JSON { type, cursorX, cursorY, rows[], normalRows[], mouseTrackingMode }
const fs = require('fs');
const { Terminal } = require('@xterm/headless');

const [file, colsArg, rowsArg, initColsArg, initRowsArg] = process.argv.slice(2);
const cols = Number.parseInt(colsArg, 10);
const rows = Number.parseInt(rowsArg, 10);
const initCols = initColsArg ? Number.parseInt(initColsArg, 10) : cols;
const initRows = initRowsArg ? Number.parseInt(initRowsArg, 10) : rows;
const data = fs.readFileSync(file);

const terminal = new Terminal({ cols: initCols, rows: initRows, allowProposedApi: true, scrollback: 200 });

function dump(buffer) {
  const out = [];
  const top = buffer.viewportY;
  for (let y = top; y < top + rows; y += 1) {
    const line = buffer.getLine(y);
    out.push(line ? line.translateToString(true) : '');
  }
  return out;
}

terminal.write(data, () => {
  if (initCols !== cols || initRows !== rows) {
    terminal.resize(cols, rows);
  }
  const active = terminal.buffer.active;
  process.stdout.write(
    JSON.stringify({
      type: active.type,
      cursorX: active.cursorX,
      cursorY: active.cursorY,
      rows: dump(active),
      // 대체화면일 때 그 아래 주 화면 — 앱을 빠져나오면 이것이 보인다.
      normalRows: dump(terminal.buffer.normal),
      // 사용자의 클릭이 앱에 가려면 이것이 none 이 아니어야 한다.
      mouseTrackingMode: terminal.modes.mouseTrackingMode,
    }),
  );
  process.exit(0);
});
