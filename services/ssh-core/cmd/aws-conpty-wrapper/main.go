//go:build windows

package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	utf8CodePage      = 65001
	keyEventType      = 0x0001
	leftCtrlPressed   = 0x0008
	mapVKVKToVSC      = 0
	virtualKeyControl = 0x11
	virtualKeyC       = 0x43
	virtualKeyZ       = 0x5A
	virtualKeyOEM5    = 0xDC
)

var (
	kernel32DLL           = windows.NewLazySystemDLL("kernel32.dll")
	user32DLL             = windows.NewLazySystemDLL("user32.dll")
	writeConsoleInputProc = kernel32DLL.NewProc("WriteConsoleInputW")
	mapVirtualKeyProc     = user32DLL.NewProc("MapVirtualKeyW")
)

type wrapperConfig struct {
	controlPipePath string
	command         []string
}

type keyEventRecord struct {
	KeyDown         int32
	RepeatCount     uint16
	VirtualKeyCode  uint16
	VirtualScanCode uint16
	UnicodeChar     uint16
	ControlKeyState uint32
}

type inputRecord struct {
	EventType uint16
	_         uint16
	KeyEvent  keyEventRecord
}

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	config, err := parseArgs(args)
	if err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err.Error())
		return 2
	}

	if err := enableConsoleUTF8(); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "enable UTF-8 console: %v\n", err)
		return 1
	}

	consoleInput, closeInput, err := openConsoleFile(
		"CONIN$",
		windows.GENERIC_READ|windows.GENERIC_WRITE,
	)
	if err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "open CONIN$: %v\n", err)
		return 1
	}
	defer closeInput()

	consoleOutput, closeOutput, err := openConsoleFile(
		"CONOUT$",
		windows.GENERIC_READ|windows.GENERIC_WRITE,
	)
	if err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "open CONOUT$: %v\n", err)
		return 1
	}
	defer closeOutput()

	if config.controlPipePath != "" {
		controlPipe, closeControlPipe, err := openControlPipe(config.controlPipePath)
		if err != nil {
			_, _ = fmt.Fprintf(consoleOutput, "open control pipe: %v\n", err)
			return 1
		}
		defer closeControlPipe()

		go relayControlSignals(controlPipe, consoleInput, consoleOutput)
	}

	jobObject, err := createKillOnCloseJobObject()
	if err != nil {
		_, _ = fmt.Fprintf(consoleOutput, "create job object: %v\n", err)
		return 1
	}
	defer windows.CloseHandle(jobObject)

	command := exec.Command(config.command[0], config.command[1:]...)
	command.Stdin = consoleInput
	command.Stdout = consoleOutput
	command.Stderr = consoleOutput
	command.Env = os.Environ()

	if err := command.Start(); err != nil {
		_, _ = fmt.Fprintf(consoleOutput, "start command: %v\n", err)
		return 1
	}

	processHandle, err := windows.OpenProcess(
		windows.PROCESS_QUERY_INFORMATION|windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE,
		false,
		uint32(command.Process.Pid),
	)
	if err != nil {
		_ = command.Process.Kill()
		_, _ = fmt.Fprintf(consoleOutput, "open child process: %v\n", err)
		return 1
	}
	if err := windows.AssignProcessToJobObject(jobObject, processHandle); err != nil {
		windows.CloseHandle(processHandle)
		_ = command.Process.Kill()
		_, _ = fmt.Fprintf(consoleOutput, "assign child process to job object: %v\n", err)
		return 1
	}
	windows.CloseHandle(processHandle)

	if err := command.Wait(); err != nil {
		var exitError *exec.ExitError
		if errors.As(err, &exitError) {
			return exitError.ExitCode()
		}
		_, _ = fmt.Fprintf(consoleOutput, "wait for command: %v\n", err)
		return 1
	}

	return 0
}

func parseArgs(args []string) (wrapperConfig, error) {
	config := wrapperConfig{}
	index := 0
	for index < len(args) {
		switch args[index] {
		case "--control-pipe":
			index++
			if index >= len(args) || args[index] == "" {
				return wrapperConfig{}, fmt.Errorf("usage: aws-conpty-wrapper [--control-pipe <pipe>] <command> [args...]")
			}
			config.controlPipePath = args[index]
			index++
		default:
			config.command = append([]string(nil), args[index:]...)
			index = len(args)
		}
	}

	if len(config.command) == 0 {
		return wrapperConfig{}, fmt.Errorf("usage: aws-conpty-wrapper [--control-pipe <pipe>] <command> [args...]")
	}

	return config, nil
}

func relayControlSignals(controlPipe *os.File, consoleInput *os.File, consoleOutput *os.File) {
	scanner := bufio.NewScanner(controlPipe)
	scanner.Buffer(make([]byte, 0, 64), 64)
	for scanner.Scan() {
		signal := scanner.Text()
		if signal == "" {
			continue
		}
		if err := injectControlSignal(consoleInput, signal); err != nil {
			_, _ = fmt.Fprintf(consoleOutput, "inject control signal %s: %v\n", signal, err)
		}
	}
}

func injectControlSignal(consoleInput *os.File, signal string) error {
	controlChar, virtualKey, err := resolveControlSignal(signal)
	if err != nil {
		return err
	}

	ctrlScanCode, err := mapVirtualKeyCode(virtualKeyControl)
	if err != nil {
		return err
	}
	scanCode, err := mapVirtualKeyCode(virtualKey)
	if err != nil {
		return err
	}

	records := []inputRecord{
		{
			EventType: keyEventType,
			KeyEvent: keyEventRecord{
				KeyDown:         1,
				RepeatCount:     1,
				VirtualKeyCode:  virtualKeyControl,
				VirtualScanCode: ctrlScanCode,
				ControlKeyState: leftCtrlPressed,
			},
		},
		{
			EventType: keyEventType,
			KeyEvent: keyEventRecord{
				KeyDown:         1,
				RepeatCount:     1,
				VirtualKeyCode:  virtualKey,
				VirtualScanCode: scanCode,
				UnicodeChar:     controlChar,
				ControlKeyState: leftCtrlPressed,
			},
		},
		{
			EventType: keyEventType,
			KeyEvent: keyEventRecord{
				KeyDown:         0,
				RepeatCount:     1,
				VirtualKeyCode:  virtualKey,
				VirtualScanCode: scanCode,
				UnicodeChar:     controlChar,
				ControlKeyState: leftCtrlPressed,
			},
		},
		{
			EventType: keyEventType,
			KeyEvent: keyEventRecord{
				KeyDown:         0,
				RepeatCount:     1,
				VirtualKeyCode:  virtualKeyControl,
				VirtualScanCode: ctrlScanCode,
			},
		},
	}

	return writeConsoleInput(consoleInput, records)
}

func resolveControlSignal(signal string) (uint16, uint16, error) {
	switch signal {
	case "interrupt":
		return 0x03, virtualKeyC, nil
	case "suspend":
		return 0x1A, virtualKeyZ, nil
	case "quit":
		return 0x1C, virtualKeyOEM5, nil
	default:
		return 0, 0, fmt.Errorf("unsupported control signal: %s", signal)
	}
}

func mapVirtualKeyCode(virtualKey uint16) (uint16, error) {
	result, _, callErr := mapVirtualKeyProc.Call(uintptr(virtualKey), uintptr(mapVKVKToVSC))
	if result == 0 {
		if callErr != windows.ERROR_SUCCESS && callErr != nil {
			return 0, fmt.Errorf("MapVirtualKeyW(%d): %w", virtualKey, callErr)
		}
		return 0, fmt.Errorf("MapVirtualKeyW(%d) returned 0", virtualKey)
	}
	return uint16(result), nil
}

func writeConsoleInput(consoleInput *os.File, records []inputRecord) error {
	if len(records) == 0 {
		return nil
	}

	var written uint32
	result, _, callErr := writeConsoleInputProc.Call(
		consoleInput.Fd(),
		uintptr(unsafe.Pointer(&records[0])),
		uintptr(len(records)),
		uintptr(unsafe.Pointer(&written)),
	)
	if result == 0 {
		if callErr != nil && callErr != windows.ERROR_SUCCESS {
			return callErr
		}
		return fmt.Errorf("WriteConsoleInputW wrote no records")
	}
	if written != uint32(len(records)) {
		return fmt.Errorf("WriteConsoleInputW wrote %d of %d records", written, len(records))
	}
	return nil
}

func enableConsoleUTF8() error {
	if err := windows.SetConsoleCP(utf8CodePage); err != nil {
		return err
	}
	if err := windows.SetConsoleOutputCP(utf8CodePage); err != nil {
		return err
	}
	return nil
}

func openConsoleFile(name string, access uint32) (*os.File, func(), error) {
	handle, err := windows.CreateFile(
		windows.StringToUTF16Ptr(name),
		access,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE,
		nil,
		windows.OPEN_EXISTING,
		0,
		0,
	)
	if err != nil {
		return nil, nil, err
	}

	file := os.NewFile(uintptr(handle), name)
	return file, func() {
		_ = file.Close()
	}, nil
}

func openControlPipe(path string) (*os.File, func(), error) {
	handle, err := windows.CreateFile(
		windows.StringToUTF16Ptr(path),
		windows.GENERIC_READ,
		0,
		nil,
		windows.OPEN_EXISTING,
		0,
		0,
	)
	if err != nil {
		return nil, nil, err
	}

	file := os.NewFile(uintptr(handle), path)
	return file, func() {
		_ = file.Close()
	}, nil
}

func createKillOnCloseJobObject() (windows.Handle, error) {
	jobObject, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, err
	}

	var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(
		jobObject,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	); err != nil {
		windows.CloseHandle(jobObject)
		return 0, err
	}

	return jobObject, nil
}
