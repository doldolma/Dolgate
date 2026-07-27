require "json"

package = JSON.parse(File.read(File.join(__dir__, "..", "..", "package.json")))

# Fail here rather than at link time. A missing framework only makes CocoaPods
# warn, and the build then dies much later with an unresolved-symbol error that
# says nothing about what to run.
unless File.directory?(File.join(__dir__, "SshCoreEngine.xcframework"))
  raise "Go SSH engine framework is missing. Build it first: npm run mobile:engine:build -- ios"
end

# The vendored framework is a build output of services/ssh-core/mobile, copied
# here by `npm run mobile:engine:build -- ios`. CocoaPods requires vendored
# frameworks to live inside the pod, which is why the build script copies rather
# than pointing at services/ssh-core/build.
Pod::Spec.new do |s|
  s.name         = "GoSshEngine"
  s.version      = package["version"]
  s.summary      = "Go SSH engine bridge for Dolgate mobile"
  s.homepage     = "https://github.com/doldolma/Dolgate"
  s.license      = { :type => "MIT" }
  s.authors      = "doldolma"
  s.source       = { :path => "." }

  s.platforms    = { :ios => min_ios_version_supported }
  s.swift_version = "5.0"

  s.source_files = "*.{swift,m,h}"
  s.vendored_frameworks = "SshCoreEngine.xcframework"

  install_modules_dependencies(s)
end
