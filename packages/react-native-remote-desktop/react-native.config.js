module.exports = {
  dependency: {
    platforms: {
      ios: {
        // CocoaPods auto-discovered via podspec
      },
      android: {
        packageImportPath: 'import com.dolssh.remotedesktop.RemoteDesktopPackage;',
        packageInstance: 'new RemoteDesktopPackage()',
      },
    },
  },
};
