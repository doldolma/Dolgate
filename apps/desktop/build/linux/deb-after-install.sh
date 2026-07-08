#!/bin/bash
# electron-builder 기본 after-install 템플릿 기반 커스텀 스크립트.
#
# 기본 템플릿은 root 로 `unshare --user` 를 검사해 user namespace 가 쓰인다고 판단하면
# chrome-sandbox 를 0755 로 두는데, Ubuntu 23.10+ 는 AppArmor 로 "비특권" userns 만 제한하므로
# root 검사는 항상 성공해 오판한다 → 앱이 SUID sandbox 폴백에서 FATAL 로 죽는다.
# Chrome/VS Code 의 deb 처럼 SUID sandbox 를 항상 활성화한다.

if type update-alternatives 2>/dev/null >&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/dolgate' -a -e '/usr/bin/dolgate' -a "`readlink '/usr/bin/dolgate'`" != '/etc/alternatives/dolgate' ]; then
        rm -f '/usr/bin/dolgate'
    fi
    update-alternatives --install '/usr/bin/dolgate' 'dolgate' '/opt/Dolgate/dolgate' 100 || ln -sf '/opt/Dolgate/dolgate' '/usr/bin/dolgate'
else
    ln -sf '/opt/Dolgate/dolgate' '/usr/bin/dolgate'
fi

chmod 4755 '/opt/Dolgate/chrome-sandbox' || true

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
