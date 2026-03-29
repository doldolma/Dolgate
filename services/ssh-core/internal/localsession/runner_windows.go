//go:build windows

package localsession

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"

	"dolssh/services/ssh-core/internal/protocol"
)

const minimumConPTYBuild = 17763

const (
	localConPTYWrapperBinaryName = "aws-conpty-wrapper.exe"
	localConPTYWrapperPathEnv    = "DOLSSH_LOCAL_CONPTY_WRAPPER_PATH"
)

type windowsConPTYRunner struct {
	shellKind     string
	process       windows.Handle
	pseudoConsole windows.Handle
	inputWriter   *os.File
	outputReader  *os.File
	closeOnce     sync.Once
}

type windowsShellRuntime struct {
	kind           string
	executablePath string
	args           []string
}

type windowsShellCandidate struct {
	kind           string
	executablePath string
	args           []string
}

const (
	windowsShellKindPwsh       = "pwsh"
	windowsShellKindPowerShell = "powershell"
	windowsShellKindCmd        = "cmd"
)

func startPlatformLocalRunner(payload protocol.LocalConnectPayload, runtime localCommandRuntime) (sessionRunner, error) {
	if err := ensureConPTYSupport(); err != nil {
		return nil, err
	}

	cols, rows := normalizedSize(payload.Cols, payload.Rows)
	inputPipe := make([]windows.Handle, 2)
	outputPipe := make([]windows.Handle, 2)
	if err := windows.Pipe(inputPipe); err != nil {
		return nil, fmt.Errorf("input pipe failed: %w", err)
	}
	if err := windows.Pipe(outputPipe); err != nil {
		windows.CloseHandle(inputPipe[0])
		windows.CloseHandle(inputPipe[1])
		return nil, fmt.Errorf("output pipe failed: %w", err)
	}
	if err := windows.SetHandleInformation(inputPipe[1], windows.HANDLE_FLAG_INHERIT, 0); err != nil {
		closeHandles(inputPipe...)
		closeHandles(outputPipe...)
		return nil, fmt.Errorf("input handle inheritance update failed: %w", err)
	}
	if err := windows.SetHandleInformation(outputPipe[0], windows.HANDLE_FLAG_INHERIT, 0); err != nil {
		closeHandles(inputPipe...)
		closeHandles(outputPipe...)
		return nil, fmt.Errorf("output handle inheritance update failed: %w", err)
	}

	var pseudoConsole windows.Handle
	attributeList, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		closeHandles(inputPipe...)
		closeHandles(outputPipe...)
		return nil, fmt.Errorf("proc thread attribute list failed: %w", err)
	}
	defer attributeList.Delete()

	cleanupOnError := true
	defer func() {
		if !cleanupOnError {
			return
		}
		if pseudoConsole != 0 {
			windows.ClosePseudoConsole(pseudoConsole)
		}
		closeHandles(inputPipe...)
		closeHandles(outputPipe...)
	}()

	if err := windows.CreatePseudoConsole(
		windows.Coord{X: int16(cols), Y: int16(rows)},
		inputPipe[0],
		outputPipe[1],
		0,
		&pseudoConsole,
	); err != nil {
		return nil, fmt.Errorf("CreatePseudoConsole failed: %w", err)
	}

	if err := attributeList.Update(
		windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
		unsafe.Pointer(pseudoConsole),
		unsafe.Sizeof(pseudoConsole),
	); err != nil {
		return nil, fmt.Errorf("pseudoconsole attribute update failed: %w", err)
	}

	startupInfo := &windows.StartupInfoEx{
		StartupInfo:             windows.StartupInfo{Cb: uint32(unsafe.Sizeof(windows.StartupInfoEx{}))},
		ProcThreadAttributeList: attributeList.List(),
	}

	commandLine := windows.ComposeCommandLine(append([]string{runtime.executablePath}, runtime.args...))
	if runtime.wrapperPath != "" {
		wrapperArgs := []string{runtime.wrapperPath, runtime.executablePath}
		wrapperArgs = append(wrapperArgs, runtime.args...)
		commandLine = windows.ComposeCommandLine(wrapperArgs)
	}
	commandLine16, err := windows.UTF16PtrFromString(commandLine)
	if err != nil {
		return nil, fmt.Errorf("command line encoding failed: %w", err)
	}

	envBlock, err := buildWindowsEnvironmentBlock(runtime.env)
	if err != nil {
		return nil, fmt.Errorf("environment block encoding failed: %w", err)
	}
	var envPtr *uint16
	if len(envBlock) > 0 {
		envPtr = &envBlock[0]
	}
	var currentDir *uint16
	if runtime.workingDirectory != "" {
		currentDir, err = windows.UTF16PtrFromString(runtime.workingDirectory)
		if err != nil {
			return nil, fmt.Errorf("working directory encoding failed: %w", err)
		}
	}

	var processInfo windows.ProcessInformation
	if err := windows.CreateProcess(
		nil,
		commandLine16,
		nil,
		nil,
		false,
		windows.CREATE_DEFAULT_ERROR_MODE|windows.CREATE_UNICODE_ENVIRONMENT|windows.EXTENDED_STARTUPINFO_PRESENT,
		envPtr,
		currentDir,
		&startupInfo.StartupInfo,
		&processInfo,
	); err != nil {
		return nil, fmt.Errorf("local shell start failed: %w", err)
	}

	closeHandles(processInfo.Thread)
	inputWriter := os.NewFile(uintptr(inputPipe[1]), "local-shell-stdin")
	outputReader := os.NewFile(uintptr(outputPipe[0]), "local-shell-stdout")

	closeHandles(inputPipe[0], outputPipe[1])
	inputPipe[0], inputPipe[1], outputPipe[0], outputPipe[1] = 0, 0, 0, 0
	cleanupOnError = false

	return &windowsConPTYRunner{
		shellKind:     runtime.shellKind,
		process:       processInfo.Process,
		pseudoConsole: pseudoConsole,
		inputWriter:   inputWriter,
		outputReader:  outputReader,
	}, nil
}

func resolveLocalRuntime(payload protocol.LocalConnectPayload) (localCommandRuntime, error) {
	if executablePath := strings.TrimSpace(payload.Executable); executablePath != "" {
		wrapperPath, err := resolveLocalConPTYWrapperPath()
		if err != nil {
			return localCommandRuntime{}, err
		}
		shellKind := strings.TrimSpace(payload.ShellKind)
		if shellKind == "" {
			shellKind = "shell"
		}
		workingDirectory := strings.TrimSpace(payload.WorkingDirectory)
		if workingDirectory == "" {
			workingDirectory = resolveUserHomeDirectory()
		}
		return localCommandRuntime{
			shellKind:        shellKind,
			executablePath:   executablePath,
			args:             append([]string(nil), payload.Args...),
			env:              buildRuntimeEnv(os.Environ(), payload.Env),
			wrapperPath:      wrapperPath,
			workingDirectory: workingDirectory,
		}, nil
	}

	shellRuntime, err := resolveWindowsShellRuntime()
	if err != nil {
		return localCommandRuntime{}, err
	}
	wrapperPath, err := resolveLocalConPTYWrapperPath()
	if err != nil {
		return localCommandRuntime{}, err
	}

	return localCommandRuntime{
		shellKind:        shellRuntime.kind,
		executablePath:   shellRuntime.executablePath,
		args:             append([]string(nil), shellRuntime.args...),
		env:              buildWindowsLocalShellEnv(os.Environ(), shellRuntime),
		wrapperPath:      wrapperPath,
		workingDirectory: resolveUserHomeDirectory(),
	}, nil
}

func resolveWindowsShellRuntime() (windowsShellRuntime, error) {
	return resolveWindowsShellRuntimeWithLookup(buildWindowsShellCandidates(), isWindowsShellUsable)
}

func resolveWindowsShellRuntimeWithLookup(candidates []windowsShellCandidate, canUse func(string) bool) (windowsShellRuntime, error) {
	for _, candidate := range candidates {
		normalized := strings.TrimSpace(candidate.executablePath)
		if normalized == "" || !isWindowsShellCandidateForKind(candidate.kind, normalized) {
			continue
		}
		if canUse(normalized) {
			return windowsShellRuntime{
				kind:           candidate.kind,
				executablePath: normalized,
				args:           append([]string(nil), candidate.args...),
			}, nil
		}
	}
	return windowsShellRuntime{}, fmt.Errorf("could not resolve a usable local Windows shell (tried pwsh.exe, powershell.exe, cmd.exe)")
}

func isWindowsShellUsable(candidate string) bool {
	if candidate == "" {
		return false
	}
	if strings.Contains(candidate, `\`) || strings.Contains(candidate, `/`) {
		info, err := os.Stat(candidate)
		return err == nil && !info.IsDir()
	}
	_, err := exec.LookPath(candidate)
	return err == nil
}

func buildWindowsShellCandidates() []windowsShellCandidate {
	candidates := make([]windowsShellCandidate, 0, 10)
	for _, candidate := range buildWindowsPowerShell7Candidates() {
		candidates = append(candidates, windowsShellCandidate{
			kind:           windowsShellKindPwsh,
			executablePath: candidate,
			args:           []string{"-NoLogo", "-NoProfile"},
		})
	}
	candidates = append(candidates,
		windowsShellCandidate{
			kind:           windowsShellKindPwsh,
			executablePath: "pwsh.exe",
			args:           []string{"-NoLogo", "-NoProfile"},
		},
		windowsShellCandidate{
			kind:           windowsShellKindPwsh,
			executablePath: "pwsh",
			args:           []string{"-NoLogo", "-NoProfile"},
		},
		windowsShellCandidate{
			kind:           windowsShellKindPowerShell,
			executablePath: resolveWindowsPowerShellCandidate(os.Getenv("SystemRoot")),
			args:           []string{"-NoLogo", "-NoProfile"},
		},
		windowsShellCandidate{
			kind:           windowsShellKindPowerShell,
			executablePath: resolveWindowsPowerShellCandidate(os.Getenv("windir")),
			args:           []string{"-NoLogo", "-NoProfile"},
		},
		windowsShellCandidate{
			kind:           windowsShellKindPowerShell,
			executablePath: `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
			args:           []string{"-NoLogo", "-NoProfile"},
		},
		windowsShellCandidate{
			kind:           windowsShellKindPowerShell,
			executablePath: "powershell.exe",
			args:           []string{"-NoLogo", "-NoProfile"},
		},
		windowsShellCandidate{
			kind:           windowsShellKindPowerShell,
			executablePath: "powershell",
			args:           []string{"-NoLogo", "-NoProfile"},
		},
		windowsShellCandidate{
			kind:           windowsShellKindCmd,
			executablePath: os.Getenv("COMSPEC"),
			args:           []string{"/d", "/k", "prompt $P$G"},
		},
		windowsShellCandidate{
			kind:           windowsShellKindCmd,
			executablePath: os.Getenv("ComSpec"),
			args:           []string{"/d", "/k", "prompt $P$G"},
		},
		windowsShellCandidate{
			kind:           windowsShellKindCmd,
			executablePath: resolveWindowsCommandProcessorCandidate(os.Getenv("SystemRoot")),
			args:           []string{"/d", "/k", "prompt $P$G"},
		},
		windowsShellCandidate{
			kind:           windowsShellKindCmd,
			executablePath: resolveWindowsCommandProcessorCandidate(os.Getenv("windir")),
			args:           []string{"/d", "/k", "prompt $P$G"},
		},
		windowsShellCandidate{
			kind:           windowsShellKindCmd,
			executablePath: `C:\Windows\System32\cmd.exe`,
			args:           []string{"/d", "/k", "prompt $P$G"},
		},
		windowsShellCandidate{
			kind:           windowsShellKindCmd,
			executablePath: "cmd.exe",
			args:           []string{"/d", "/k", "prompt $P$G"},
		},
		windowsShellCandidate{
			kind:           windowsShellKindCmd,
			executablePath: "cmd",
			args:           []string{"/d", "/k", "prompt $P$G"},
		},
	)
	return candidates
}

func buildWindowsPowerShell7Candidates() []string {
	roots := []string{
		os.Getenv("ProgramFiles"),
		os.Getenv("ProgramW6432"),
		os.Getenv("ProgramFiles(x86)"),
		`C:\Program Files`,
		`C:\Program Files (x86)`,
	}
	candidates := make([]string, 0, len(roots))
	seen := make(map[string]struct{}, len(roots))
	for _, root := range roots {
		normalizedRoot := strings.TrimSpace(root)
		if normalizedRoot == "" {
			continue
		}
		candidate := filepath.Join(normalizedRoot, "PowerShell", "7", "pwsh.exe")
		seenKey := strings.ToLower(candidate)
		if _, ok := seen[seenKey]; ok {
			continue
		}
		seen[seenKey] = struct{}{}
		candidates = append(candidates, candidate)
	}
	return candidates
}

func isWindowsShellCandidateForKind(kind string, candidate string) bool {
	base := strings.ToLower(filepath.Base(candidate))
	switch kind {
	case windowsShellKindPwsh:
		return base == "pwsh" || base == "pwsh.exe"
	case windowsShellKindPowerShell:
		return base == "powershell" || base == "powershell.exe"
	case windowsShellKindCmd:
		return isWindowsCommandProcessorCandidate(candidate)
	default:
		return false
	}
}

func isWindowsCommandProcessorCandidate(candidate string) bool {
	base := strings.ToLower(filepath.Base(candidate))
	return base == "cmd" || base == "cmd.exe"
}

func resolveWindowsPowerShellCandidate(root string) string {
	normalizedRoot := strings.TrimSpace(root)
	if normalizedRoot == "" {
		return ""
	}
	return filepath.Join(normalizedRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
}

func resolveWindowsCommandProcessorCandidate(root string) string {
	normalizedRoot := strings.TrimSpace(root)
	if normalizedRoot == "" {
		return ""
	}
	return filepath.Join(normalizedRoot, "System32", "cmd.exe")
}

func buildWindowsLocalShellEnv(base []string, shell windowsShellRuntime) []string {
	env := make([]string, 0, len(base)+4)
	seen := make(map[string]int, len(base)+4)
	windowsRoot :=
		lookupWindowsEnvValue(base, "SystemRoot")
	if windowsRoot == "" {
		windowsRoot = lookupWindowsEnvValue(base, "windir")
	}
	if windowsRoot == "" {
		windowsRoot = inferWindowsRootFromExecutable(shell.executablePath)
	}
	if windowsRoot == "" {
		windowsRoot = `C:\Windows`
	}

	appendOrReplace := func(key, value string) {
		if strings.TrimSpace(value) == "" {
			return
		}
		normalizedKey := strings.ToLower(key)
		entry := fmt.Sprintf("%s=%s", key, value)
		if index, ok := seen[normalizedKey]; ok {
			env[index] = entry
			return
		}
		seen[normalizedKey] = len(env)
		env = append(env, entry)
	}

	for _, entry := range base {
		parts := strings.SplitN(entry, "=", 2)
		if len(parts) != 2 {
			continue
		}
		appendOrReplace(parts[0], parts[1])
	}

	comspec := lookupWindowsEnvValue(base, "COMSPEC")
	if comspec == "" {
		comspec = resolveWindowsCommandProcessorCandidate(windowsRoot)
	}
	appendOrReplace("COMSPEC", comspec)
	if windowsRoot != "" {
		appendOrReplace("SystemRoot", windowsRoot)
		appendOrReplace("windir", windowsRoot)
	}
	return env
}

func lookupWindowsEnvValue(env []string, key string) string {
	target := strings.ToLower(key)
	for _, entry := range env {
		parts := strings.SplitN(entry, "=", 2)
		if len(parts) != 2 {
			continue
		}
		if strings.ToLower(parts[0]) == target {
			return strings.TrimSpace(parts[1])
		}
	}
	return ""
}

func inferWindowsRootFromExecutable(executablePath string) string {
	normalizedPath := strings.TrimSpace(executablePath)
	if normalizedPath == "" {
		return ""
	}
	cleaned := filepath.Clean(normalizedPath)
	currentDir := filepath.Dir(cleaned)
	for currentDir != "" && currentDir != filepath.Dir(currentDir) {
		if strings.EqualFold(filepath.Base(currentDir), "System32") {
			return filepath.Dir(currentDir)
		}
		currentDir = filepath.Dir(currentDir)
	}
	return ""
}

func resolveUserHomeDirectory() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return home
}

func resolveLocalConPTYWrapperPath() (string, error) {
	if override := strings.TrimSpace(os.Getenv(localConPTYWrapperPathEnv)); override != "" {
		if isWindowsShellUsable(override) && strings.EqualFold(filepath.Ext(override), ".exe") {
			return override, nil
		}
		return "", fmt.Errorf("local conpty wrapper not found: %s", override)
	}

	currentExecutable, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("resolve ssh-core executable path: %w", err)
	}

	candidate := filepath.Join(filepath.Dir(currentExecutable), localConPTYWrapperBinaryName)
	if isWindowsShellUsable(candidate) && strings.EqualFold(filepath.Ext(candidate), ".exe") {
		return candidate, nil
	}

	return "", fmt.Errorf("local conpty wrapper not found next to ssh-core: %s", candidate)
}

func (r *windowsConPTYRunner) Write(data []byte) error {
	_, err := r.inputWriter.Write(data)
	return err
}

func (r *windowsConPTYRunner) Resize(cols, rows int) error {
	cols, rows = normalizedSize(cols, rows)
	return windows.ResizePseudoConsole(r.pseudoConsole, windows.Coord{X: int16(cols), Y: int16(rows)})
}

func (r *windowsConPTYRunner) Kill() error {
	if r.process == 0 {
		return nil
	}

	err := windows.TerminateProcess(r.process, 1)
	if err == nil || err == windows.ERROR_ACCESS_DENIED || err == windows.ERROR_INVALID_HANDLE {
		return nil
	}
	return err
}

func (r *windowsConPTYRunner) Close() error {
	var firstErr error
	r.closeOnce.Do(func() {
		if r.inputWriter != nil {
			if err := r.inputWriter.Close(); err != nil && firstErr == nil {
				firstErr = err
			}
		}
		if r.outputReader != nil {
			if err := r.outputReader.Close(); err != nil && firstErr == nil {
				firstErr = err
			}
		}
		if r.pseudoConsole != 0 {
			windows.ClosePseudoConsole(r.pseudoConsole)
			r.pseudoConsole = 0
		}
		if r.process != 0 {
			if err := windows.CloseHandle(r.process); err != nil && firstErr == nil {
				firstErr = err
			}
			r.process = 0
		}
	})
	return firstErr
}

func (r *windowsConPTYRunner) Streams() []io.Reader {
	return []io.Reader{r.outputReader}
}

func (r *windowsConPTYRunner) Wait() (sessionExit, error) {
	if r.process == 0 {
		return sessionExit{ExitCode: 0}, nil
	}

	if _, err := windows.WaitForSingleObject(r.process, windows.INFINITE); err != nil {
		return sessionExit{}, err
	}

	var exitCode uint32
	if err := windows.GetExitCodeProcess(r.process, &exitCode); err != nil {
		return sessionExit{}, err
	}

	return sessionExit{ExitCode: int(exitCode)}, nil
}

func (r *windowsConPTYRunner) ShellKind() string {
	return r.shellKind
}

func ensureConPTYSupport() error {
	version := windows.RtlGetVersion()
	if version.MajorVersion < 10 || version.BuildNumber < minimumConPTYBuild {
		return fmt.Errorf("Windows 10 1809+/Server 2019+ 이상에서만 로컬 터미널 interactive session을 지원합니다.")
	}
	return nil
}

func closeHandles(handles ...windows.Handle) {
	for _, handle := range handles {
		if handle != 0 {
			_ = windows.CloseHandle(handle)
		}
	}
}

func buildWindowsEnvironmentBlock(env []string) ([]uint16, error) {
	if len(env) == 0 {
		return utf16.Encode([]rune("\x00\x00")), nil
	}

	block := make([]uint16, 0, len(env)*2)
	for _, entry := range env {
		if !strings.Contains(entry, "=") {
			continue
		}
		for _, character := range entry {
			block = utf16.AppendRune(block, character)
		}
		block = utf16.AppendRune(block, 0)
	}
	block = utf16.AppendRune(block, 0)
	return block, nil
}
