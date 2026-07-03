package http

// AwsSsmRuntime describes AWS feature availability to the router and the
// capability endpoints. SSM sessions/tunnels ride ssh-core's in-process data
// channel and SSO/EC2 Instance Connect go through the AWS SDK, so nothing
// depends on aws CLI or session-manager-plugin binaries anymore and the
// features are unconditionally available. The struct shape is kept so client
// capability responses and router gating stay wire-compatible.
type AwsSsmRuntime struct {
	Enabled                      bool
	AwsSsoBrowserFlowSupported   bool
	AwsSsoBrowserFlowReason      string
	AwsSsoBrowserFlowRecoverable bool
}

func DetectAwsSsmRuntime() AwsSsmRuntime {
	return AwsSsmRuntime{
		Enabled:                    true,
		AwsSsoBrowserFlowSupported: true,
	}
}
