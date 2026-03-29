//go:build windows

package main

import (
	"bufio"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/windows"
)

type tuiMode string

const (
	shellMode tuiMode = "shell"
	topMode   tuiMode = "top"
	viMode    tuiMode = "vi"
)

type fakeTerminalApp struct {
	mu       sync.Mutex
	outputMu sync.Mutex
	mode     tuiMode
	cols     int
	rows     int
	tick     int
}

func main() {
	app := &fakeTerminalApp{mode: shellMode}

	app.write("FAKE AWS SSM READY\r\n")
	app.refreshSize()
	app.printSize()
	installSignalMarkers(app)
	app.printPrompt()

	done := make(chan struct{})
	defer close(done)
	app.startResizeMonitor(done)

	input, closeInput := openConsoleInput()
	defer closeInput()

	scanner := bufio.NewScanner(input)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		app.handleInput(line)
	}
}

func (app *fakeTerminalApp) handleInput(line string) {
	app.mu.Lock()
	mode := app.mode
	app.mu.Unlock()

	switch mode {
	case topMode:
		if line == "q" {
			app.exitTUI()
			return
		}
		app.renderCurrent()
		return
	case viMode:
		if line == ":q" || line == "q" {
			app.exitTUI()
			return
		}
		app.renderCurrent()
		return
	default:
		app.handleShellInput(line)
	}
}

func (app *fakeTerminalApp) handleShellInput(line string) {
	switch line {
	case "__START_FAKE_TOP__":
		app.enterMode(topMode)
	case "__START_FAKE_VI__":
		app.enterMode(viMode)
	case "__REPORT_SIZE__":
		app.refreshSize()
		app.printSize()
		app.printPrompt()
	default:
		app.writef("ECHO:%s\r\n", line)
		app.printPrompt()
	}
}

func (app *fakeTerminalApp) enterMode(mode tuiMode) {
	app.mu.Lock()
	app.mode = mode
	app.tick = 0
	app.mu.Unlock()
	app.refreshSize()
	app.write("\x1b[?1049h\x1b[?25l")
	app.renderCurrent()
}

func (app *fakeTerminalApp) exitTUI() {
	app.mu.Lock()
	app.mode = shellMode
	app.tick = 0
	app.mu.Unlock()
	app.write("\x1b[?25h\x1b[?1049l")
	app.printPrompt()
}

func (app *fakeTerminalApp) startResizeMonitor(done <-chan struct{}) {
	ticker := time.NewTicker(100 * time.Millisecond)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				app.mu.Lock()
				mode := app.mode
				app.mu.Unlock()
				if mode == shellMode {
					continue
				}
				if app.refreshSize() {
					app.renderCurrent()
				}
			}
		}
	}()
}

func (app *fakeTerminalApp) refreshSize() bool {
	cols := 140
	rows := 40
	info := windows.ConsoleScreenBufferInfo{}
	if err := windows.GetConsoleScreenBufferInfo(windows.Handle(os.Stdout.Fd()), &info); err == nil {
		cols = maxInt(int(info.Size.X), 40)
		rows = maxInt(int(info.Size.Y), 12)
	}

	app.mu.Lock()
	changed := cols != app.cols || rows != app.rows
	app.cols = cols
	app.rows = rows
	app.mu.Unlock()
	return changed
}

func (app *fakeTerminalApp) printSize() {
	app.mu.Lock()
	cols := app.cols
	rows := app.rows
	app.mu.Unlock()
	app.writef("SIZE:%dx%d\r\n", cols, rows)
}

func (app *fakeTerminalApp) printPrompt() {
	app.write("PROMPT> ready\r\n")
}

func (app *fakeTerminalApp) renderCurrent() {
	app.mu.Lock()
	mode := app.mode
	cols := app.cols
	rows := app.rows
	app.tick += 1
	tick := app.tick
	app.mu.Unlock()

	switch mode {
	case topMode:
		app.write(renderTopScreen(cols, rows, tick))
	case viMode:
		app.write(renderViScreen(cols, rows))
	}
}

func (app *fakeTerminalApp) write(data string) {
	app.outputMu.Lock()
	defer app.outputMu.Unlock()
	fmt.Print(data)
}

func (app *fakeTerminalApp) writef(format string, args ...any) {
	app.write(fmt.Sprintf(format, args...))
}

func renderTopScreen(cols, rows, tick int) string {
	lines := []string{
		fitLine(fmt.Sprintf("top - fake session | tick %02d | %dx%d", tick, cols, rows), cols),
		fitLine("Tasks: 7 total, 1 running, 6 sleeping", cols),
		fitLine("CPU: 3.2% usr 1.1% sys 95.7% idle", cols),
		"",
		fitLine("PID   USER      COMMAND         CPU%   MEM%", cols),
		fitLine("101   root      fake-top         3.2    1.1", cols),
		fitLine("202   app       renderer         1.4    4.8", cols),
		fitLine("303   postgres  writer           0.6    2.1", cols),
	}

	for len(lines) < rows-1 {
		lines = append(lines, "")
	}
	lines = append(lines[:rows-1], fitLine("Press q to quit fake top", cols))
	return "\x1b[H\x1b[2J" + strings.Join(lines[:rows], "\r\n")
}

func renderViScreen(cols, rows int) string {
	lines := []string{
		fitLine("\"fake.txt\" [deterministic replay fixture]", cols),
		fitLine("Hello from fake vi.", cols),
		fitLine("This screen redraws when the PTY size changes.", cols),
		"",
	}

	for len(lines) < rows-1 {
		lines = append(lines, "~")
	}

	status := fitLine(fmt.Sprintf("NORMAL  fake.txt  %dx%d  :q to quit", cols, rows), cols)
	lines = append(lines[:rows-1], status)
	return "\x1b[H\x1b[2J" + strings.Join(lines[:rows], "\r\n")
}

func fitLine(line string, cols int) string {
	if cols <= 0 {
		return line
	}
	if len(line) <= cols {
		return line
	}
	if cols <= 1 {
		return line[:cols]
	}
	return line[:cols-1] + "…"
}

func installSignalMarkers(app *fakeTerminalApp) {
	signals := make(chan os.Signal, 4)
	signal.Notify(signals, os.Interrupt)
	go func() {
		for range signals {
			app.write("SIGNAL:INT\r\n")
		}
	}()
}

func openConsoleInput() (*os.File, func()) {
	handle, err := windows.CreateFile(
		windows.StringToUTF16Ptr("CONIN$"),
		windows.GENERIC_READ|windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE,
		nil,
		windows.OPEN_EXISTING,
		0,
		0,
	)
	if err != nil {
		return os.Stdin, func() {}
	}

	file := os.NewFile(uintptr(handle), "CONIN$")
	return file, func() {
		_ = file.Close()
	}
}

func maxInt(value, fallback int) int {
	if value > 0 {
		return value
	}
	return fallback
}
