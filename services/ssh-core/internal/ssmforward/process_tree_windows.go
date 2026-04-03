//go:build windows

package ssmforward

import (
	"fmt"
	"os/exec"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

type processTreeKiller interface {
	Kill() error
	Close() error
}

type windowsJobObject struct {
	handle    windows.Handle
	closeOnce sync.Once
}

func attachProcessTreeKiller(cmd *exec.Cmd) (processTreeKiller, error) {
	if cmd == nil || cmd.Process == nil {
		return nil, nil
	}

	jobObject, err := createKillOnCloseJobObject()
	if err != nil {
		return nil, err
	}

	processHandle, err := windows.OpenProcess(
		windows.PROCESS_QUERY_INFORMATION|windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE,
		false,
		uint32(cmd.Process.Pid),
	)
	if err != nil {
		windows.CloseHandle(jobObject)
		return nil, fmt.Errorf("open aws ssm process: %w", err)
	}
	defer windows.CloseHandle(processHandle)

	if err := windows.AssignProcessToJobObject(jobObject, processHandle); err != nil {
		windows.CloseHandle(jobObject)
		return nil, fmt.Errorf("assign aws ssm process to job object: %w", err)
	}

	return &windowsJobObject{handle: jobObject}, nil
}

func (j *windowsJobObject) Kill() error {
	return j.Close()
}

func (j *windowsJobObject) Close() error {
	var closeErr error
	j.closeOnce.Do(func() {
		if j.handle == 0 {
			return
		}
		closeErr = windows.CloseHandle(j.handle)
		if closeErr == windows.ERROR_INVALID_HANDLE {
			closeErr = nil
		}
		j.handle = 0
	})
	return closeErr
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
