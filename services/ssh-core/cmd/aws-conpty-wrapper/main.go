//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"unsafe"

	"golang.org/x/sys/windows"
)

const utf8CodePage = 65001

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) == 0 {
		_, _ = fmt.Fprintln(os.Stderr, "usage: aws-conpty-wrapper <command> [args...]")
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

	jobObject, err := createKillOnCloseJobObject()
	if err != nil {
		_, _ = fmt.Fprintf(consoleOutput, "create job object: %v\n", err)
		return 1
	}
	defer windows.CloseHandle(jobObject)

	command := exec.Command(args[0], args[1:]...)
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
