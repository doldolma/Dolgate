package hostsoverrideipc

import "os"

func socketFileMode(goos string) os.FileMode {
	if goos == "darwin" || goos == "linux" {
		// darwin/linux에서는 권한 상승된 helper(root)가 socket을 만들고,
		// 원래 앱 프로세스(user)가 다시 연결해야 한다.
		// socket 자체는 auth token으로 보호되고, 상위 디렉터리가 user-private(0700)이라서
		// (darwin: user temp dir, linux: XDG_RUNTIME_DIR) 재연결 가능한 mode를 사용한다.
		return 0o666
	}
	return 0o600
}
