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
		return Unsupported()
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
	return `( if [ -n "${BASH_VERSION:-}" ]; then shell_name=bash; elif [ -n "${ZSH_VERSION:-}" ]; then shell_name=zsh; else shell_path="${SHELL:-}"; if command -v getent >/dev/null 2>&1; then shell_path="$(getent passwd "$(id -un)" | cut -d: -f7)"; fi; shell_name="${shell_path##*/}"; fi; case "$shell_name" in bash|zsh) ;; *) printf 'S\0%s\0' "$shell_name"; exit 0 ;; esac; printf 'S\0%s\0' "$shell_name"; hist="$HOME/.${shell_name}_history"; if [ -r "$hist" ]; then tail -n 2000 "$hist" | while IFS= read -r line; do printf 'H\0%s\0' "$line"; done; fi; old_ifs="$IFS"; IFS=:; count=0; for dir in $PATH; do [ -d "$dir" ] || continue; for file in "$dir"/*; do [ "$count" -lt 5000 ] || break 2; [ -f "$file" ] && [ -x "$file" ] || continue; name="${file##*/}"; printf 'E\0%s\0%s\0' "$name" "$file"; count=$((count + 1)); done; done; IFS="$old_ifs" ) | head -c 1048576`
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
// A=prompt start, B=command input start, C=command output start, D;<exit>=done.
const shellIntegrationScript = `__ds_o(){ printf '\033]133;%s\007' "$1"; }; __ds_cwd(){ printf '\033]7;file://%s\007' "$PWD"; }; ` +
	`if [ -n "${BASH_VERSION:-}" ]; then ` +
	`__ds_pc(){ local __e=$?; __ds_o "D;$__e"; __ds_o A; __ds_cwd; }; ` +
	`case ";${PROMPT_COMMAND:-};" in *__ds_pc*) ;; *) PROMPT_COMMAND="__ds_pc${PROMPT_COMMAND:+;$PROMPT_COMMAND}";; esac; ` +
	`case "${PS1:-}" in *'133;B'*) ;; *) PS1="${PS1:-}"'\[\033]133;B\007\]';; esac; ` +
	`case "${PS0:-}" in *'133;C'*) ;; *) PS0="${PS0:-}"'\033]133;C\007';; esac; ` +
	`elif [ -n "${ZSH_VERSION:-}" ]; then ` +
	`__ds_precmd(){ local __e=$?; __ds_o "D;$__e"; __ds_o A; __ds_cwd; }; __ds_preexec(){ __ds_o C; }; ` +
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
var injectedCommandEcho = []byte(
	strings.TrimSuffix(strings.TrimPrefix(ShellIntegrationInitCommand(), " "), "\r"),
)

func stripInjectedEcho(data []byte) []byte {
	if len(data) == 0 || len(injectedCommandEcho) == 0 {
		return data
	}
	return bytes.ReplaceAll(data, injectedCommandEcho, nil)
}

// HandshakeFilter hides the injected shell-integration command's echo: it
// suppresses interactive output from injection until the first OSC 133;A prompt
// marker, then forwards everything from that marker onward and becomes a no-op.
// If the marker never arrives within the byte budget (or on Flush after a
// timeout), the buffered bytes are released so no real output is lost.
type HandshakeFilter struct {
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
		// redraw) so it never reaches the screen.
		return stripInjectedEcho(chunk), false
	}
	f.buffer = append(f.buffer, chunk...)

	// preserveMotd: 주입 echo가 찍힌 프롬프트 줄 "직전"까지(=motd 등 로그인 출력)를 한 번
	// 흘려보내고, echo 줄부터는 마커가 올 때까지 계속 버퍼링한다. 이렇게 하면 첫(통합 전)
	// 프롬프트와 echo가 흡수되고, motd는 그대로 남아 통합 프롬프트만 1개로 보인다. 흘려보낸
	// motd가 이후 append에 덮이지 않도록 남은 버퍼는 새 백킹으로 복사한다.
	var motd []byte
	if f.preserveMotd && !f.motdSeen {
		if echoIdx := bytes.Index(f.buffer, injectedCommandEcho); echoIdx >= 0 {
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
		out := append(append([]byte(nil), motd...), stripInjectedEcho(f.buffer[idx:])...)
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
	out := stripInjectedEcho(f.buffer)
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
