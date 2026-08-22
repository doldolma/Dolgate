require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "react-native-remote-desktop"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = "https://github.com/doldolma/Dolgate"
  s.license      = { :type => "MIT" }
  s.authors      = "doldolma"
  s.source       = { :path => "." }

  s.platforms    = { :ios => min_ios_version_supported }
  s.swift_version = "5.0"

  s.source_files = "ios/**/*.{swift,h,m,mm,cpp}"
  # Swift imports both Rust C ABIs through CocoaPods' generated underlying Clang
  # module. Framework/module targets cannot use a bridging header on Xcode 26.
  s.public_header_files = "ios/dvnc.h", "ios/drdp.h"
  s.frameworks   = "AVFAudio", "Metal", "MetalKit", "QuartzCore", "UIKit"

  # ── Rust remote-desktop cores ─────────────────────────────────────
  # Script phases build static libraries for the current target architecture.
  # No prebuilt binaries are committed.

  s.pod_target_xcconfig = {
    'OTHER_LDFLAGS' => '-lvnc_core -lrdp_core -lc++',
    'LIBRARY_SEARCH_PATHS' => '$(inherited) "$(BUILT_PRODUCTS_DIR)"',
    'SWIFT_INCLUDE_PATHS' => '$(inherited) "$(PODS_TARGET_SRCROOT)/ios"',
    # Enable the generated Clang module used by Swift's underlying-module import.
    'DEFINES_MODULE' => 'YES',
  }

  s.user_target_xcconfig = {
    'LIBRARY_SEARCH_PATHS' => '$(inherited) "$(BUILT_PRODUCTS_DIR)"',
    # Static pod archives do not absorb external archives during libtool; the
    # final application link must resolve both Rust ABI symbol families.
    'OTHER_LDFLAGS' => '$(inherited) -lvnc_core -lrdp_core -lc++',
  }

  s.script_phase = {
    :name => 'Build remote desktop Rust libraries',
    :script => '/bin/bash "${PODS_TARGET_SRCROOT}/ios/build-vnc-core-ios.sh" && /bin/bash "${PODS_TARGET_SRCROOT}/ios/build-rdp-core-ios.sh"',
    :execution_position => :before_compile,
    # Rust dependency graphs include workspace crates and vendored trees that Xcode cannot infer.
    # Enter every build; Cargo performs the precise incremental check for both archives.
    :always_out_of_date => '1',
    :output_files => [
      '$(BUILT_PRODUCTS_DIR)/libvnc_core.a',
      '$(BUILT_PRODUCTS_DIR)/librdp_core.a',
    ],
    :shell_path => '/bin/bash',
  }

  install_modules_dependencies(s)
end
