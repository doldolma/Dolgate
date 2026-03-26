//go:build windows

package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"golang.org/x/sys/windows"
)

func main() {
	input, closeInput := openConsoleInput()
	defer closeInput()
	output, closeOutput := openConsoleOutput()
	defer closeOutput()

	writeLine(output, "FAKE LOCAL SHELL READY")
	printTerminalSize(output)

	scanner := bufio.NewScanner(input)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		switch line {
		case "":
			continue
		case "__REPORT_SIZE__":
			printTerminalSize(output)
		default:
			writeLine(output, "ECHO:"+line)
		}
	}
}

func printTerminalSize(output *os.File) {
	info := windows.ConsoleScreenBufferInfo{}
	err := windows.GetConsoleScreenBufferInfo(windows.Handle(output.Fd()), &info)
	if err != nil {
		writeLine(output, fmt.Sprintf("SIZE:%dx%d", 300, 100))
		return
	}

	writeLine(output, fmt.Sprintf("SIZE:%dx%d", int(info.Size.X), int(info.Size.Y)))
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

func openConsoleOutput() (*os.File, func()) {
	handle, err := windows.CreateFile(
		windows.StringToUTF16Ptr("CONOUT$"),
		windows.GENERIC_READ|windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE,
		nil,
		windows.OPEN_EXISTING,
		0,
		0,
	)
	if err != nil {
		return os.Stdout, func() {}
	}

	file := os.NewFile(uintptr(handle), "CONOUT$")
	return file, func() {
		_ = file.Close()
	}
}

func writeLine(output *os.File, line string) {
	_, _ = fmt.Fprintf(output, "%s\r\n", line)
}
