package hostsoverrideipc

import "os"

func socketFileMode(goos string) os.FileMode {
	if goos == "darwin" {
		// macOS에서는 권한 상승된 helper(root)가 socket을 만들고,
		// 원래 앱 프로세스(user)가 다시 연결해야 한다.
		// socket 자체는 auth token으로 보호되고, 상위 temp dir은 user-private(0700)라서
		// darwin에서는 재연결 가능한 mode를 사용한다.
		return 0o666
	}
	return 0o600
}
