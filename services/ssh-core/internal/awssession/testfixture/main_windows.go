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
	fmt.Print("FAKE AWS SSM READY\r\n")
	printTerminalSize()

	input, closeInput := openConsoleInput()
	defer closeInput()

	scanner := bufio.NewScanner(input)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		switch line {
		case "":
			continue
		case "__REPORT_SIZE__":
			printTerminalSize()
		default:
			fmt.Printf("ECHO:%s\r\n", line)
		}
	}
}

func printTerminalSize() {
	info := windows.ConsoleScreenBufferInfo{}
	err := windows.GetConsoleScreenBufferInfo(windows.Handle(os.Stdout.Fd()), &info)
	if err != nil {
		fmt.Printf("SIZE:%dx%d\r\n", 300, 100)
		return
	}

	fmt.Printf("SIZE:%dx%d\r\n", int(info.Size.X), int(info.Size.Y))
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
