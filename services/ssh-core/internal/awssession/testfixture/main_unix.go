//go:build !windows

package main

import (
	"bufio"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
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

	app.write("READY:FAKE_AWS_SSM\r\n")
	app.writef("TTY:%t\r\n", isTTY())
	app.refreshSize()
	app.printSize()
	installSignalMarkers(app)
	app.printPrompt()

	done := make(chan struct{})
	defer close(done)
	app.startResizeMonitor(done)

	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		app.handleInput(line)
	}
}

func isTTY() bool {
	_, err := unix.IoctlGetWinsize(int(os.Stdout.Fd()), unix.TIOCGWINSZ)
	return err == nil
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
	size, err := unix.IoctlGetWinsize(int(os.Stdout.Fd()), unix.TIOCGWINSZ)
	cols := 120
	rows := 32
	if err == nil {
		cols = maxInt(int(size.Col), 40)
		rows = maxInt(int(size.Row), 12)
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
	signals := make(chan os.Signal, 8)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTSTP, syscall.SIGQUIT)
	go func() {
		for received := range signals {
			switch received {
			case syscall.SIGINT:
				app.write("SIGNAL:INT\r\n")
			case syscall.SIGTSTP:
				app.write("SIGNAL:TSTP\r\n")
			case syscall.SIGQUIT:
				app.write("SIGNAL:QUIT\r\n")
			}
		}
	}()
}

func maxInt(value, fallback int) int {
	if value > 0 {
		return value
	}
	return fallback
}
