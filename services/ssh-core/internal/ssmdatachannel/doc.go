// Package ssmdatachannel implements the client side of the AWS SSM Session Manager
// data channel protocol: the WebSocket connection carrying AgentMessage binary frames
// (input/output stream data, acknowledgements, handshake, resize, flags) between this
// client and the SSM agent on the target instance/container.
//
// Vendored from github.com/mmmorris1975/ssm-session-client (datachannel package),
// commit 73b175a8a93e0c712d1ef75b2b49d819b2fcc3f9, MIT License (see LICENSE in this
// directory).
//
// Local changes from upstream:
//   - package renamed datachannel → ssmdatachannel
//   - Open(aws.Config, *ssm.StartSessionInput) and the internal startSession helper
//     were removed, dropping the aws-sdk-go-v2 dependency. OpenWithSessionToken
//     replaces them: callers obtain {StreamUrl, TokenValue} themselves (in Dolgate,
//     the Electron main process issues tokens via ssm:StartSession /
//     ecs:ExecuteCommand and passes them to ssh-core), so this package never needs
//     AWS credentials.
package ssmdatachannel
