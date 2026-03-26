//go:build !windows

package main

import (
	"bufio"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

func main() {
	fmt.Printf("TTY:%t\r\n", isTTY())
	printTTYSize()
	installSignalMarkers()

	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		switch line {
		case "":
			continue
		case "__REPORT_SIZE__":
			printTTYSize()
		default:
			fmt.Printf("ECHO:%s\r\n", line)
		}
	}
}

func isTTY() bool {
	_, err := unix.IoctlGetWinsize(int(os.Stdout.Fd()), unix.TIOCGWINSZ)
	return err == nil
}

func printTTYSize() {
	size, err := unix.IoctlGetWinsize(int(os.Stdout.Fd()), unix.TIOCGWINSZ)
	if err != nil {
		fmt.Printf("SIZE:ERR:%v\r\n", err)
		return
	}

	fmt.Printf("SIZE:%dx%d\r\n", int(size.Col), int(size.Row))
}

func installSignalMarkers() {
	signals := make(chan os.Signal, 8)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTSTP, syscall.SIGQUIT)
	go func() {
		for received := range signals {
			switch received {
			case syscall.SIGINT:
				fmt.Printf("SIGNAL:INT\r\n")
			case syscall.SIGTSTP:
				fmt.Printf("SIGNAL:TSTP\r\n")
			case syscall.SIGQUIT:
				fmt.Printf("SIGNAL:QUIT\r\n")
			}
		}
	}()
}
