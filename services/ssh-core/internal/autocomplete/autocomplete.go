package autocomplete

import (
	"bytes"
	"encoding/base64"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	"dolssh/services/ssh-core/pkg/coretypes"
)

const (
	MaxHistoryItems    = 2000
	MaxExecutableItems = 5000
	MaxMetadataBytes   = 1024 * 1024
)

// Dynamic-completion (host command) execution bounds.
const (
	CompletionTimeout  = 8 * time.Second
	MaxCompletionBytes = 256 * 1024
)

// CapOutput truncates completion command output to MaxCompletionBytes.
func CapOutput(data []byte) (string, bool) {
	if len(data) > MaxCompletionBytes {
		return string(data[:MaxCompletionBytes]), true
	}
	return string(data), false
}

// PromptStartMarker is the OSC 133;A sequence emitted by the shell integration
// hooks when a fresh prompt is drawn. Seeing it confirms the integration was
// installed successfully (the handshake) and marks a prompt boundary.
const PromptStartMarker = "\x1b]133;A\x07"

// PromptInputStartMarker is the OSC 133;B sequence appended to PS1 by the shell
// integration. It terminates the visible prompt redraw that follows a hidden
// in-band probe.
const PromptInputStartMarker = "\x1b]133;B\x07"

// maxHandshakeBytes bounds how much output the handshake filter buffers while
// waiting for the first prompt marker before giving up and flushing.
const maxHandshakeBytes = 64 * 1024

type Result struct {
	Capability coretypes.TerminalAutocompleteCapabilityPayload
	Snapshot   *coretypes.TerminalAutocompleteSnapshotPayload
}

func Unsupported() Result {
	return Result{Capability: coretypes.TerminalAutocompleteCapabilityPayload{
		Status: "unsupported", Sources: []string{}, ReasonCode: "unsupported-shell",
	}}
}

func Degraded(shell string, reason string) Result {
	sources := []string{"session-history"}
	return Result{
		Capability: coretypes.TerminalAutocompleteCapabilityPayload{
			Status: "degraded", Shell: NormalizeShell(shell), Sources: sources, ReasonCode: reason,
		},
	}
}

func NormalizeShell(value string) string {
	base := normalizeShellName(value)
	switch base {
	case "bash", "zsh":
		return base
	default:
		return ""
	}
}

func NormalizeShellIntegrationShell(value string) string {
	base := normalizeShellName(value)
	switch base {
	case "bash", "zsh", "fish", "pwsh", "powershell":
		return base
	default:
		return ""
	}
}

func normalizeShellName(value string) string {
	base := strings.TrimSpace(value)
	base = strings.ReplaceAll(base, "\\", "/")
	base = filepath.Base(base)
	base = strings.ToLower(strings.TrimPrefix(base, "-"))
	return strings.TrimSuffix(base, ".exe")
}

func ParseSnapshot(data []byte, revision int) Result {
	if len(data) > MaxMetadataBytes {
		data = data[:MaxMetadataBytes]
	}
	fields := bytes.Split(data, []byte{0})
	var shell string
	var hostOs *coretypes.TerminalHostOs
	history := make([]string, 0, 256)
	executables := make([]coretypes.TerminalAutocompleteExecutable, 0, 512)
	truncated := false
	seenExecutables := make(map[string]struct{})

	for index := 0; index < len(fields); {
		kind := string(fields[index])
		index++
		switch kind {
		case "S":
			if index < len(fields) {
				shell = NormalizeShell(string(fields[index]))
				index++
			}
		case "O":
			// id, like, prettyName 세 칸. id 가 없으면 무의미하므로 버린다.
			if index+2 >= len(fields) {
				index = len(fields)
				continue
			}
			id := strings.ToLower(strings.TrimSpace(string(fields[index])))
			like := strings.ToLower(strings.TrimSpace(string(fields[index+1])))
			pretty := strings.TrimSpace(string(fields[index+2]))
			index += 3
			if id != "" && !hasUnsafeControl(id) && !hasUnsafeControl(pretty) {
				hostOs = &coretypes.TerminalHostOs{Id: id, Like: like, PrettyName: pretty}
			}
		case "H":
			if index >= len(fields) {
				continue
			}
			value := normalizeHistoryLine(shell, string(fields[index]))
			index++
			if value == "" {
				continue
			}
			if len(history) >= MaxHistoryItems {
				truncated = true
				continue
			}
			history = append(history, value)
		case "E":
			if index+1 >= len(fields) {
				index = len(fields)
				continue
			}
			name := strings.TrimSpace(string(fields[index]))
			path := strings.TrimSpace(string(fields[index+1]))
			index += 2
			if name == "" || hasUnsafeControl(name) || hasUnsafeControl(path) {
				continue
			}
			if _, exists := seenExecutables[name]; exists {
				continue
			}
			seenExecutables[name] = struct{}{}
			if len(executables) >= MaxExecutableItems {
				truncated = true
				continue
			}
			executables = append(executables, coretypes.TerminalAutocompleteExecutable{Name: name, Path: path})
		default:
			// Ignore unknown fields so newer collectors remain backward compatible.
		}
	}

	if shell == "" {
		// 자동완성은 못 하지만(bash·zsh 가 아니다) OS 는 읽었을 수 있다. NAS·컨테이너처럼
		// ash 를 쓰는 호스트가 그렇다 — 아이콘은 셸과 상관이 없으니 그것만 실어 보낸다.
		result := Unsupported()
		if hostOs != nil {
			result.Snapshot = &coretypes.TerminalAutocompleteSnapshotPayload{
				Revision:    revision,
				History:     []string{},
				Executables: []coretypes.TerminalAutocompleteExecutable{},
				Os:          hostOs,
			}
		}
		return result
	}
	sort.Slice(executables, func(left, right int) bool {
		return executables[left].Name < executables[right].Name
	})
	return Result{
		Capability: coretypes.TerminalAutocompleteCapabilityPayload{
			Status: "ready", Shell: shell, Sources: []string{"history", "executable", "session-history"},
		},
		Snapshot: &coretypes.TerminalAutocompleteSnapshotPayload{
			Shell: shell, Revision: revision, History: history, Executables: executables, Truncated: truncated,
			Os: hostOs,
		},
	}
}

func CollectLocal(shellHint string, revision int) Result {
	shell := NormalizeShell(shellHint)
	if shell == "" {
		return Unsupported()
	}
	var output bytes.Buffer
	writeField(&output, "S", shell)
	home, _ := os.UserHomeDir()
	historyPath := filepath.Join(home, "."+shell+"_history")
	if content, err := readFileTail(historyPath, MaxMetadataBytes); err == nil {
		for _, line := range strings.Split(string(content), "\n") {
			writeField(&output, "H", line)
		}
	}
	for _, directory := range filepath.SplitList(os.Getenv("PATH")) {
		entries, err := os.ReadDir(directory)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			info, err := entry.Info()
			if err != nil || info.Mode()&0111 == 0 {
				continue
			}
			writeFields(&output, "E", entry.Name(), filepath.Join(directory, entry.Name()))
		}
	}
	return ParseSnapshot(output.Bytes(), revision)
}

func RemoteSnapshotCommand() string {
	return `( if [ -n "${BASH_VERSION:-}" ]; then shell_name=bash; elif [ -n "${ZSH_VERSION:-}" ]; then shell_name=zsh; else shell_path="${SHELL:-}"; if command -v getent >/dev/null 2>&1; then shell_path="$(getent passwd "$(id -un)" | cut -d: -f7)"; fi; shell_name="${shell_path##*/}"; fi; ` + osProbeCommand + `case "$shell_name" in bash|zsh) ;; *) printf 'S\0%s\0' "$shell_name"; exit 0 ;; esac; printf 'S\0%s\0' "$shell_name"; hist="$HOME/.${shell_name}_history"; if [ -r "$hist" ]; then tail -n 2000 "$hist" | while IFS= read -r line; do printf 'H\0%s\0' "$line"; done; fi; old_ifs="$IFS"; IFS=:; count=0; for dir in $PATH; do [ -d "$dir" ] || continue; for file in "$dir"/*; do [ "$count" -lt 5000 ] || break 2; [ -f "$file" ] && [ -x "$file" ] || continue; name="${file##*/}"; printf 'E\0%s\0%s\0' "$name" "$file"; count=$((count + 1)); done; done; IFS="$old_ifs" ) | head -c 1048576`
}

func InBandProbeCommand(nonce string) string {
	encodedNonce := strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '-' || r == '_' {
			return r
		}
		return -1
	}, nonce)
	return " (" + RemoteSnapshotCommand() + ") | base64 | tr -d '\\r\\n' | { printf '\\033]6973;" + encodedNonce + ";snapshot;'; cat; printf '\\007'; }; history -d $((HISTCMD-1)) >/dev/null 2>&1 || true\r"
}

func DecodeInBandSnapshot(value []byte, revision int) (Result, error) {
	decoded := make([]byte, base64.StdEncoding.DecodedLen(len(value)))
	n, err := base64.StdEncoding.Decode(decoded, value)
	if err != nil {
		return Result{}, err
	}
	return ParseSnapshot(decoded[:n], revision), nil
}

/**
 * 호스트 OS 를 읽는 조각. 스냅샷 명령 안에서 한 번만 돈다 — 연결마다 1회라 왕복이 늘지 않는다.
 *
 * **셸 게이트보다 앞에 둔다.** 그 아래에서 bash·zsh 가 아니면 명령이 곧바로 끝나는데, NAS·컨테이너
 * 처럼 ash(busybox)를 쓰는 호스트도 OS 는 알려줄 수 있어야 한다. 이 조각은 test·sed·uname·printf
 * 뿐이라 POSIX 셸이면 어디서든 돈다.
 *
 * 순서가 중요하다. **표시 파일이 os-release 를 이긴다** — Proxmox·TrueNAS SCALE·openmediavault·
 * Raspberry Pi OS 는 os-release 가 `ID=debian` 이라, 그대로 두면 전부 데비안으로 보인다. 그래서
 * os-release 를 먼저 읽어 두고 그 위에 표시 파일로 덮는다(이름은 더 정확한 쪽을 쓴다).
 *
 * os-release 를 소스(`.`)하지 않고 sed 로 뽑는다. 소스하면 그 파일이 정의한 변수(NAME·VERSION
 * 등)가 스냅샷 명령의 변수를 덮을 수 있다.
 *
 * 아무것도 못 읽으면 출력하지 않는다 — 앱은 그때 예전처럼 글자 뱃지를 그린다.
 */
const osProbeCommand = `os_id=""; os_like=""; os_name=""; ` +
	`if [ -r /etc/os-release ]; then ` +
	`os_id="$(sed -n 's/^ID=//p' /etc/os-release | head -n1 | tr -d '\"')"; ` +
	`os_like="$(sed -n 's/^ID_LIKE=//p' /etc/os-release | head -n1 | tr -d '\"')"; ` +
	`os_name="$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release | head -n1 | tr -d '\"')"; fi; ` +
	// 표시 파일. 위에서 읽은 값을 덮는다(가장 구체적인 것이 이긴다).
	`if [ -d /etc/pve ]; then os_id=pve; os_like=""; os_name="Proxmox VE"; ` +
	`elif [ -r /etc/unraid-version ]; then os_id=unraid; os_like=""; ` +
	`os_name="Unraid $(sed -n 's/^version=//p' /etc/unraid-version | head -n1 | tr -d '\"')"; ` +
	`elif [ -r /etc/config/uLinux.conf ]; then os_id=qts; os_like=""; os_name="QNAP QTS"; ` +
	`elif [ -r /etc/VERSION ] && [ -r /etc/synoinfo.conf ]; then os_id=dsm; os_like=""; ` +
	`os_name="Synology DSM $(sed -n 's/^productversion=//p' /etc/VERSION | head -n1 | tr -d '\"')"; ` +
	`elif [ -d /usr/local/opnsense ]; then os_id=opnsense; os_like=""; os_name="OPNsense"; ` +
	`elif [ -r /etc/platform ] && [ "$(head -n1 /etc/platform)" = pfSense ]; then os_id=pfsense; os_like=""; ` +
	`os_name="pfSense $(head -n1 /etc/version 2>/dev/null)"; ` +
	`elif [ -r /etc/version ] && [ "$(cut -c1-7 /etc/version)" = TrueNAS ]; then os_id=truenas; os_like=""; ` +
	`os_name="$(head -n1 /etc/version)"; ` +
	`elif [ -d /etc/openmediavault ]; then os_id=omv; os_like=""; os_name="openmediavault"; ` +
	// Raspberry Pi OS 는 64비트에서 os-release 가 `ID=debian` 이다 — 이름은 그쪽이 더 정확해 남긴다.
	`elif [ -r /etc/rpi-issue ]; then os_id=raspbian; os_like=debian; ` +
	`elif [ -r /system/build.prop ]; then os_id=android; os_like=""; os_name="Android"; fi; ` +
	// os-release 도 표시 파일도 없는 호스트: 커널 이름·버전만이라도 남긴다. macOS 는 sw_vers,
	// ESXi 는 uname 이 VMkernel 을 준다.
	`if [ -z "$os_id" ]; then os_kernel="$(uname -s 2>/dev/null)"; os_rel="$(uname -r 2>/dev/null)"; ` +
	`if [ "$os_kernel" = Darwin ]; then os_id=darwin; os_name="macOS $(sw_vers -productVersion 2>/dev/null)"; ` +
	`elif [ -n "$os_kernel" ]; then os_id="$os_kernel"; os_name="$os_kernel $os_rel"; fi; fi; ` +
	`[ -n "$os_id" ] && printf 'O\0%s\0%s\0%s\0' "$os_id" "$os_like" "$os_name"; `

func normalizeHistoryLine(shell string, value string) string {
	value = strings.TrimSpace(value)
	if shell == "zsh" && strings.HasPrefix(value, ": ") {
		if separator := strings.Index(value, ";"); separator >= 0 {
			value = strings.TrimSpace(value[separator+1:])
		}
	}
	if value == "" || hasUnsafeControl(value) || isInjectedShellIntegration(value) {
		return ""
	}
	return value
}

// isInjectedShellIntegration reports whether a history line is one of the
// commands Dolgate types into the shell to bootstrap autocomplete — the OSC 133
// integration script (ShellIntegrationInitCommand) and the in-band snapshot
// probe (InBandProbeCommand). zsh keeps these in history (the trailing bash
// `history -d $((HISTCMD-1))` self-cleanup is a no-op in zsh), so without this
// they leak into completion suggestions. Matched by their private markers,
// which no real user command contains.
func isInjectedShellIntegration(value string) bool {
	return strings.Contains(value, "__ds_o") ||
		strings.Contains(value, "]133;%s") ||
		strings.Contains(value, "]6973;")
}

func hasUnsafeControl(value string) bool {
	return strings.ContainsFunc(value, func(r rune) bool {
		return unicode.IsControl(r)
	})
}

func writeField(buffer *bytes.Buffer, kind string, value string) {
	writeFields(buffer, kind, value)
}

func writeFields(buffer *bytes.Buffer, values ...string) {
	for _, value := range values {
		buffer.WriteString(value)
		buffer.WriteByte(0)
	}
}

func readFileTail(path string, limit int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if info.Size() > limit {
		if _, err := file.Seek(-limit, io.SeekEnd); err != nil {
			return nil, err
		}
	}
	return io.ReadAll(io.LimitReader(file, limit))
}

// shellIntegrationScript installs OSC 133 prompt/command lifecycle hooks for an
// interactive bash or zsh shell. It is shell-agnostic (branches on
// BASH_VERSION/ZSH_VERSION), idempotent, and appends to any existing
// PROMPT_COMMAND / precmd / preexec hooks instead of replacing them. Markers:
// A=prompt start, B=command input start, C=command output start, D;<exit>=done,
// E;<command>=the command text as the shell accepted it (zsh only — see below).
//
// 길이 제한은 없다. 예전에는 마커 뒤 재출력 echo 를 청크별 전체 일치로 지워서 1024바이트
// (로컬 PTY 한 번 읽기 상한)를 넘기면 스크립트가 화면에 찍혔다. 지금은 꼬리를 물고 잇는
// 스트리밍 치환이라(stripInjectedEchoStreaming) 길이와 무관하다.
const shellIntegrationScript = `__ds_o(){ printf '\033]133;%s\007' "$1"; }; __ds_cwd(){ printf '\033]7;file://%s\007' "$PWD"; }; ` +
	`if [ -n "${BASH_VERSION:-}" ]; then ` +
	`__ds_pc(){ local __e=$?; __ds_o "D;$__e"; __ds_o A; __ds_cwd; }; ` +
	// 여러 줄을 "실행하지 않고 입력줄에 넣기" 는 셸이 괄호 붙여넣기를 받아야 성립한다. bash 는
	// 5.1 부터 기본으로 켜지므로 그 아래 버전(우분투 20.04 = 5.0)에서는 우리가 켠다. 없는
	// 옵션이면 bind 가 조용히 실패한다.
	`bind 'set enable-bracketed-paste on' 2>/dev/null; ` +
	`case ";${PROMPT_COMMAND:-};" in *__ds_pc*) ;; *) PROMPT_COMMAND="__ds_pc${PROMPT_COMMAND:+;$PROMPT_COMMAND}";; esac; ` +
	`case "${PS1:-}" in *'133;B'*) ;; *) PS1="${PS1:-}"'\[\033]133;B\007\]';; esac; ` +
	`case "${PS0:-}" in *'133;C'*) ;; *) PS0="${PS0:-}"'\033]133;C\007';; esac; ` +
	// 이어지는 줄(PS2)에도 마커를 붙인다. bash 는 명령 원문을 알려줄 방법이 없어(133;E 불가)
	// 화면을 읽어야 하는데, 그러면 화면에 찍힌 PS2("> ")가 명령에 섞인다 — `cat \` 다음 줄이
	// `> test.txt` 로 읽혀 이어 붙이면 `cat > test.txt`(리다이렉트)가 된다.
	//
	// 마커를 붙이면 셸이 매 줄마다 "여기까지가 프롬프트다" 를 알려주므로 추측하지 않아도 된다.
	// PS1 과 구분해야 하므로(빈 엔터로 새 프롬프트가 뜨는 것과 이어지는 줄은 다르다) 파라미터를
	// 하나 붙여 `B;2` 로 보낸다.
	`case "${PS2:-}" in *'133;B'*) ;; *) PS2="${PS2:-}"'\[\033]133;B;2\007\]';; esac; ` +
	`elif [ -n "${ZSH_VERSION:-}" ]; then ` +
	// zsh 의 preexec 은 **셸이 받아들인 명령 원문**을 $1 로 준다(여러 줄까지). 그것을 E 로
	// 올려 보내면 화면에서 읽지 않아도 되고, 화면에 찍힌 보조 프롬프트(PS2: `heredoc> `)가
	// 섞이는 문제가 사라진다. C 보다 먼저 보내 블록이 만들어질 때 쓸 수 있게 한다.
	//
	// 이스케이프: OSC 페이로드에 raw 개행이 들어가면 파서가 시퀀스를 중단한다. 역슬래시를 먼저
	// 두 배로 만든 뒤 개행을 `\n` 으로 바꾼다 — 그래야 `echo back\slash` 와 여러 줄이 구분된다.
	`__ds_precmd(){ local __e=$?; __ds_o "D;$__e"; __ds_o A; __ds_cwd; }; ` +
	`__ds_e(){ local t=${1//\\/\\\\}; __ds_o "E;${t//$'\n'/\\n}"; }; ` +
	`__ds_preexec(){ __ds_e "$1"; __ds_o C; }; ` +
	`typeset -ga precmd_functions preexec_functions; ` +
	// Membership test via case on the space-joined array, mirroring the bash
	// PROMPT_COMMAND guard above. Avoids zsh-only arithmetic subscripts like
	// ${arr[(I)x]}: bash still parses this elif branch even though it never runs
	// it, and the (( … )) arithmetic context rejects (I)… as a syntax error on
	// bash 5.1.x (e.g. WSL/Ubuntu), which would break the whole script there.
	// precmd_functions+=(…) is bash/zsh array-append syntax that a POSIX sh
	// (dash) subshell cannot parse — and dash parses the whole line before
	// running it, so a bare += here makes injecting into a dash/sh subshell abort
	// with a visible "Syntax error". Wrapping the append in eval '…' keeps it an
	// opaque string to dash's parser (this elif branch never executes there),
	// while bash/zsh still eval the append normally.
	`case " ${precmd_functions[*]} " in *" __ds_precmd "*) ;; *) eval 'precmd_functions+=(__ds_precmd)';; esac; ` +
	`case " ${preexec_functions[*]} " in *" __ds_preexec "*) ;; *) eval 'preexec_functions+=(__ds_preexec)';; esac; ` +
	`case "${PS1:-}" in *'133;B'*) ;; *) PS1="${PS1:-}"$'%{\033]133;B\007%}';; esac; ` +
	`fi`

// fishIntegrationScript installs OSC 133 prompt/command lifecycle hooks without
// replacing the user's fish_prompt. fish keeps its own completion UI; this only
// reports prompt boundaries, cwd, and command lifecycle events to the terminal.
const fishIntegrationScript = `if not set -q __ds_shell_integration_installed; ` +
	`set -g __ds_shell_integration_installed 1; ` +
	`function __ds_cwd; printf '\033]7;file://%s\007' (pwd); end; ` +
	`function __ds_prompt --on-event fish_prompt; printf '\033]133;A\007'; __ds_cwd; printf '\033]133;B\007'; end; ` +
	`function __ds_preexec --on-event fish_preexec; printf '\033]133;C\007'; end; ` +
	`function __ds_postexec --on-event fish_postexec; printf "\033]133;D;$status\007"; end; ` +
	`end`

// powerShellIntegrationScript installs OSC 133 prompt/command lifecycle hooks
// for Windows PowerShell / PowerShell 7. The prompt wrapper is the reliable
// baseline; PSReadLine command-start hooks are best-effort because older or
// stripped environments may not expose Set-PSReadLineOption.
const powerShellIntegrationScript = `if (-not (Get-Variable -Name __ds_shell_integration_installed -Scope Global -ErrorAction SilentlyContinue)) { ` +
	`Set-Variable -Name __ds_shell_integration_installed -Scope Global -Value $true; ` +
	`function global:__ds_o { param([string]$Value) [Console]::Write(([char]27) + ']133;' + $Value + ([char]7)) }; ` +
	`function global:__ds_cwd { try { $path = (Get-Location).ProviderPath; if ([string]::IsNullOrEmpty($path)) { $path = (Get-Location).Path }; $uri = [System.Uri]::new($path).AbsoluteUri; [Console]::Write(([char]27) + ']7;' + $uri + ([char]7)) } catch {} }; ` +
	`$global:__ds_prompt = (Get-Command prompt -CommandType Function -ErrorAction SilentlyContinue).ScriptBlock; ` +
	`function global:prompt { $global:__ds_last_success = $?; $global:__ds_last_exit = $LASTEXITCODE; if ($global:__ds_last_success) { $code = 0 } elseif ($null -ne $global:__ds_last_exit) { $code = [int]$global:__ds_last_exit } else { $code = 1 }; __ds_o ('D;' + $code); __ds_o 'A'; __ds_cwd; __ds_o 'B'; if ($global:__ds_prompt) { & $global:__ds_prompt } else { 'PS ' + $executionContext.SessionState.Path.CurrentLocation + ('>' * ($nestedPromptLevel + 1)) + ' ' } }; ` +
	`try { $global:__ds_add_history = (Get-PSReadLineOption).AddToHistoryHandler; Set-PSReadLineOption -AddToHistoryHandler { param([string]$line) __ds_o 'C'; if ($global:__ds_add_history) { return & $global:__ds_add_history $line }; return $true } } catch {} ` +
	`}`

// ShellIntegrationInitCommand returns a one-line command, suitable for writing
// straight into an interactive shell's stdin, that installs the OSC 133 hooks.
// The leading space keeps it out of history when HISTCONTROL/HIST_IGNORE_SPACE
// is set, and the trailing `history -d` is a best-effort cleanup (bash), both
// mirroring InBandProbeCommand.
func ShellIntegrationInitCommand() string {
	return " " + shellIntegrationScript + "; history -d $((HISTCMD-1)) >/dev/null 2>&1 || true\r"
}

// FishShellIntegrationInitCommand returns a one-line command suitable for fish
// sessions. It intentionally does not enable Dolgate autocomplete snapshots.
func FishShellIntegrationInitCommand() string {
	return " " + fishIntegrationScript + "\r"
}

// PowerShellIntegrationInitCommand returns a one-line command suitable for
// Windows local PowerShell sessions.
func PowerShellIntegrationInitCommand() string {
	return " " + powerShellIntegrationScript + "\r"
}

// PowerShellIntegrationScript 는 기동 인자(-EncodedCommand)로 넘길 순수 스크립트다. stdin 으로
// 타이핑하는 경로와 달리 앞 공백·끝 CR 이 없다.
//
// 이 경로가 필요한 이유는 커서 어긋남이다. stdin 으로 넣으면 셸이 그 줄을 echo 하고 우리가 그것을
// 화면에서 걷어내는데, 걷어낸 바이트에는 줄바꿈도 들어 있어서 conhost 의 커서만 내려가고 화면의
// 커서는 그대로 남는다. 이 스크립트는 1385 바이트라 200 칸 화면에서 7 행을 차지하므로 어긋남이
// 그만큼 커진다 — 실기기에서 첫 프롬프트가 두 번 찍히고 첫 입력이 7 행 아래에 찍혔다. PSReadLine
// 은 절대 좌표로 입력줄을 다시 그리기 때문에 이 어긋남이 스스로 낫지 않는다.
func PowerShellIntegrationScript() string {
	return powerShellIntegrationScript
}

func ShellIntegrationInitCommandForShell(shell string) (string, bool) {
	switch NormalizeShellIntegrationShell(shell) {
	case "bash", "zsh":
		return ShellIntegrationInitCommand(), true
	case "fish":
		return FishShellIntegrationInitCommand(), true
	case "pwsh", "powershell":
		return PowerShellIntegrationInitCommand(), true
	default:
		return "", false
	}
}

// injectedCommandEcho is the visible text the shell echoes back for the injected
// init command (without the leading space / trailing CR). On a slow host the
// command can land in the input buffer before the first prompt and get echoed
// twice — once raw, and again as a prompt redraw that arrives *after* the OSC
// 133;A marker — so the handshake's "drop everything before the marker" rule
// can't hide that second copy. We strip this text from every forwarded path
// instead, so the injection never reaches the screen regardless of timing.
var injectedCommandEcho = visibleInjectedEcho(ShellIntegrationInitCommand())

// visibleInjectedEcho 는 주입 명령에서 화면에 보이는 부분만 남긴다(앞 공백·끝 CR 제거).
func visibleInjectedEcho(command string) []byte {
	return []byte(strings.TrimSuffix(strings.TrimPrefix(command, " "), "\r"))
}

// echoText 는 이 필터가 걷어낼 echo 다. 무장할 때 실제로 주입한 명령을 받지 못했으면 bash/zsh
// 스크립트로 되돌아간다(그 셸이 기본 경로다).
//
// 셸마다 주입하는 스크립트가 다르기 때문에 필터가 이것을 알아야 한다. 실제로 그렇게 깨졌다:
// 로컬 PowerShell 에는 pwsh 스크립트를 주입하는데 걷어내는 쪽은 bash 문자열을 찾아서, 마커
// 뒤에 오는 프롬프트 재출력이 그대로 화면에 남았다 — 첫 줄에 프롬프트가 두 번 찍히고 첫 입력이
// 엉뚱한 열에서 시작했다.
func (f *HandshakeFilter) echoText() []byte {
	if len(f.echo) > 0 {
		return f.echo
	}
	return injectedCommandEcho
}

func (f *HandshakeFilter) stripInjectedEcho(data []byte) []byte {
	echo := f.echoText()
	if len(data) == 0 || len(echo) == 0 {
		return data
	}
	return bytes.ReplaceAll(data, echo, nil)
}

/**
 * 청크 경계를 넘어서도 echo 를 지운다.
 *
 * 왜 필요한가: 마커 뒤에 오는 프롬프트 재출력의 echo 는 청크 단위로 지워 왔다. 그런데 로컬 PTY 는
 * 한 번에 1024바이트까지만 주므로(4096 버퍼로 읽어도) 주입 스크립트가 그보다 길면 어떤 청크에도
 * 통째로 들어가지 않아 **하나도 지워지지 않는다** — 스크립트가 화면에 그대로 찍힌다. 그래서
 * 스크립트 길이에 1024바이트 천장이 생겨 있었다.
 *
 * 방법: 아직 내보내지 않은 꼬리를 들고 있다가 다음 청크와 이어 붙여 찾는다. 다만 꼬리를 무조건
 * 붙들면 화면이 그만큼 늦게 그려지므로, **echo 의 접두사가 될 수 있는 만큼만** 붙든다. 평소
 * 출력은 `__ds_o(){ printf` 로 시작하지 않으니 붙드는 양은 0 이다.
 */
func (f *HandshakeFilter) stripInjectedEchoStreaming(chunk []byte) []byte {
	echo := f.echoText()
	if len(echo) == 0 {
		return chunk
	}
	// 지울 일이 끝났으면(한 번 지웠거나 예산을 다 썼으면) 붙들지 않고 그대로 흘려보낸다.
	//
	// 세션이 끝날 때까지 계속 찾으면, 사용자가 우연히 같은 글자를 출력했을 때 그것도 지워진다.
	// 재출력은 마커 직후에 오므로 짧은 예산으로 충분하다.
	if f.echoScrubDone {
		return chunk
	}
	pending := append(f.pendingEcho, chunk...)
	f.pendingEcho = nil
	f.echoScrubBudget += len(chunk)

	cleaned := bytes.ReplaceAll(pending, echo, nil)
	if len(cleaned) != len(pending) {
		// 한 번 지웠으면 끝이다 — 재출력은 한 번뿐이다.
		f.echoScrubDone = true
		return cleaned
	}
	if f.echoScrubBudget >= maxEchoScrubBytes {
		f.echoScrubDone = true
		return cleaned
	}
	// 뒤쪽이 echo 의 시작일 수 있으면 그만큼만 붙들어 둔다.
	hold := prefixOverlap(cleaned, echo)
	if hold == 0 {
		return cleaned
	}
	f.pendingEcho = append([]byte(nil), cleaned[len(cleaned)-hold:]...)
	return cleaned[:len(cleaned)-hold]
}

/** 붙들어 둔 꼬리를 내보낸다(필터를 끝낼 때). */
func (f *HandshakeFilter) drainPendingEcho() []byte {
	if len(f.pendingEcho) == 0 {
		return nil
	}
	out := f.pendingEcho
	f.pendingEcho = nil
	return out
}

/** data 의 접미사이면서 동시에 prefix 의 접두사인 가장 긴 길이(prefix 전체와 같은 경우는 뺀다). */
func prefixOverlap(data []byte, prefix []byte) int {
	max := len(prefix) - 1
	if len(data) < max {
		max = len(data)
	}
	for size := max; size > 0; size-- {
		if bytes.Equal(data[len(data)-size:], prefix[:size]) {
			return size
		}
	}
	return 0
}

// HandshakeFilter hides the injected shell-integration command's echo: it
// suppresses interactive output from injection until the first OSC 133;A prompt
// marker, then forwards everything from that marker onward and becomes a no-op.
// If the marker never arrives within the byte budget (or on Flush after a
// timeout), the buffered bytes are released so no real output is lost.
/**
 * 마커 뒤 재출력을 찾는 동안 볼 최대 바이트.
 *
 * 재출력은 마커 바로 다음 청크에 온다. 이 예산을 넘기면 찾기를 접고 그대로 흘려보낸다 — 두 가지
 * 이유다. 세션이 끝날 때까지 찾으면 (1) 사용자가 우연히 같은 글자를 출력했을 때 그것도 지워지고,
 * (2) echo 의 접두사로 끝나는 출력을 계속 붙들게 된다.
 */
const maxEchoScrubBytes = 8 * 1024

type HandshakeFilter struct {
	// echo 는 이 세션에 실제로 주입한 명령의 보이는 텍스트다. 비어 있으면 bash/zsh 기본값을 쓴다.
	echo []byte
	// pendingEcho 는 아직 내보내지 않은 꼬리다 — echo 의 접두사가 될 수 있는 만큼만 붙든다.
	pendingEcho []byte
	// 재출력을 한 번 지웠거나 예산을 다 쓰면 true. 그 뒤로는 그대로 흘려보낸다.
	echoScrubDone   bool
	echoScrubBudget int
	// preserveMotd가 true면 주입 echo가 찍힌 프롬프트 줄 "이전" 출력(로그인 motd 등)은
	// 흘려보내고, echo 줄 시작 ~ 첫 133;A 마커만 버린다. false면 Arm~133;A 전부 버린다(기존
	// 동작). SSH 로그인 셸에서 motd를 보존하면서 통합 프롬프트만 1개로 보이게 하는 용도다.
	preserveMotd bool
	motdSeen     bool
	done         bool
	buffer       []byte
}

// Filter consumes one chunk of session output and returns the bytes to forward
// to the renderer plus whether the prompt marker completed the handshake on
// this chunk.
func (f *HandshakeFilter) Filter(chunk []byte) (forward []byte, handshakeDone bool) {
	if f.done {
		// After the handshake, still scrub a late injected-command echo (prompt
		// redraw) so it never reaches the screen. 청크 경계를 넘겨도 잡아야 한다 —
		// 로컬 PTY 는 한 번에 1024바이트까지만 준다.
		return f.stripInjectedEchoStreaming(chunk), false
	}
	f.buffer = append(f.buffer, chunk...)

	// preserveMotd: 주입 echo가 찍힌 프롬프트 줄 "직전"까지(=motd 등 로그인 출력)를 한 번
	// 흘려보내고, echo 줄부터는 마커가 올 때까지 계속 버퍼링한다. 이렇게 하면 첫(통합 전)
	// 프롬프트와 echo가 흡수되고, motd는 그대로 남아 통합 프롬프트만 1개로 보인다. 흘려보낸
	// motd가 이후 append에 덮이지 않도록 남은 버퍼는 새 백킹으로 복사한다.
	var motd []byte
	if f.preserveMotd && !f.motdSeen {
		if echoIdx := bytes.Index(f.buffer, f.echoText()); echoIdx >= 0 {
			lineStart := bytes.LastIndexByte(f.buffer[:echoIdx], '\n') + 1
			motd = f.buffer[:lineStart]
			f.buffer = append([]byte(nil), f.buffer[lineStart:]...)
			f.motdSeen = true
		}
	}

	if idx := bytes.Index(f.buffer, []byte(PromptStartMarker)); idx >= 0 {
		f.done = true
		// Forward motd (preserveMotd) then everything from the marker on, dropping
		// the injected echo that the prompt line may redraw right after the marker.
		out := append(append([]byte(nil), motd...), f.stripInjectedEcho(f.buffer[idx:])...)
		f.buffer = nil
		return out, true
	}
	if len(motd) > 0 {
		// motd만 내보내고 echo 줄 이후(첫 프롬프트 redraw)는 마커가 올 때까지 버퍼에 둔다.
		return motd, false
	}
	if len(f.buffer) > maxHandshakeBytes {
		return f.Flush(), false
	}
	return nil, false
}

// Flush releases any buffered output and stops suppressing. Used when the
// handshake times out so the user still sees whatever the shell produced.
func (f *HandshakeFilter) Flush() []byte {
	if f.done {
		return nil
	}
	f.done = true
	// Marker never arrived (slow/incompatible host): release the real output but
	// scrub the injected command echo so it isn't left on the screen.
	out := f.stripInjectedEcho(f.buffer)
	f.buffer = nil
	return out
}

// Done reports whether the filter has stopped suppressing (marker seen or
// flushed).
func (f *HandshakeFilter) Done() bool {
	return f.done
}

// Handshake bundles a HandshakeFilter with a mutex so session managers can
// share the OSC 133 echo-suppression lifecycle. The zero value is ready to use
// and acts as a pass-through until Arm is called. It must not be copied after
// first use (embed it in a pointer-accessed session handle).
type Handshake struct {
	mu     sync.Mutex
	filter *HandshakeFilter
}

// Arm starts suppressing output until the first prompt marker. Call it right
// before writing the integration init command. preserveMotd keeps output before
// the injected command's prompt line (e.g. SSH login motd) visible; pass false
// for the legacy "drop everything before the marker" behavior.
func (h *Handshake) Arm(preserveMotd bool) {
	h.mu.Lock()
	h.filter = &HandshakeFilter{preserveMotd: preserveMotd}
	h.mu.Unlock()
}

// ArmForCommand 는 Arm 과 같지만, 걷어낼 echo 를 **실제로 주입하는 명령**으로 지정한다.
//
// 셸마다 주입 스크립트가 다른 경로(ShellIntegrationInitCommandForShell)에서는 이것을 써야 한다.
// Arm 은 bash/zsh 스크립트를 가정하므로, pwsh·fish 세션에서는 마커 뒤에 오는 프롬프트 재출력이
// 걸러지지 않고 화면에 남는다.
func (h *Handshake) ArmForCommand(preserveMotd bool, command string) {
	h.mu.Lock()
	h.filter = &HandshakeFilter{
		preserveMotd: preserveMotd,
		echo:         visibleInjectedEcho(command),
	}
	h.mu.Unlock()
}

// Filter returns the bytes to forward to the renderer, suppressing the injected
// command's echo while armed and not yet completed.
func (h *Handshake) Filter(chunk []byte) []byte {
	forward, _ := h.FilterWithStatus(chunk)
	return forward
}

// FilterWithStatus is like Filter, and also reports whether this chunk
// completed the OSC 133;A handshake.
func (h *Handshake) FilterWithStatus(chunk []byte) ([]byte, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.filter == nil {
		return chunk, false
	}
	forward, handshakeDone := h.filter.Filter(chunk)
	return forward, handshakeDone
}

// Flush releases any buffered output (handshake-timeout path) so nothing is
// lost; returns the bytes to forward.
func (h *Handshake) Flush() []byte {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.filter == nil || h.filter.Done() {
		return nil
	}
	return h.filter.Flush()
}
