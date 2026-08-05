#!/bin/bash
# deb·rpm 공용 after-install. electron-builder 기본 템플릿(after-install.tpl)을 그대로 두고
# chrome-sandbox 결정만 바꾼 것이다.
#
# 기본 템플릿은 root 로 `unshare --user` 를 검사해 user namespace 가 쓸 수 있다고 판단하면
# chrome-sandbox 를 0755 로 둔다. 그런데 Ubuntu 23.10+ 는 AppArmor 로 "비특권" userns 만
# 제한하므로 root 검사는 항상 성공해 오판하고, 앱은 SUID sandbox 폴백에서 FATAL 로 죽는다.
# Chrome·VS Code 의 패키지처럼 SUID sandbox 를 항상 활성화한다.
#
# ${executable} / ${sanitizedProductName} 는 electron-builder 가 치환한다 — 실행 파일명이
# 바뀌어도 이 스크립트는 따라간다.

if type update-alternatives >/dev/null 2>&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# 기본 템플릿과 다른 유일한 지점 — 조건 없이 SUID 로 설치한다(위 주석 참고).
chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

# Install apparmor profile. (Ubuntu 24+)
# First check if the version of AppArmor running on the device supports our profile.
# This is in order to keep backwards compatibility with Ubuntu 22.04 which does not support abi/4.0.
# In that case, we just skip installing the profile since the app runs fine without it on 22.04.
#
# Those apparmor_parser flags are akin to performing a dry run of loading a profile.
# https://wiki.debian.org/AppArmor/HowToUse#Dumping_profiles
#
# rpm 계열(Fedora·RHEL)에는 AppArmor 가 없어 apparmor_status 검사에서 그대로 빠져나간다.
if apparmor_status --enabled > /dev/null 2>&1; then
  APPARMOR_PROFILE_SOURCE='/opt/${sanitizedProductName}/resources/apparmor-profile'
  APPARMOR_PROFILE_TARGET='/etc/apparmor.d/${executable}'
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"

    # Updating the current AppArmor profile is not possible and probably not meaningful in a chroot'ed environment.
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      # Extra flags taken from dh_apparmor:
      # > By using '-W -T' we ensure that any abstraction updates are also pulled in.
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
    fi
  else
    echo "Skipping the installation of the AppArmor profile as this version of AppArmor does not seem to support the bundled profile"
  fi
fi
