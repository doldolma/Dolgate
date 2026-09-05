# Dolgate Documentation

## Using Dolgate

1. [Desktop guide](./desktop.md) — every desktop feature and how to use it: SSH terminals, RDP/VNC remote desktops, autocomplete, AI, SFTP, tmux, mosh
2. [Tailscale / Headscale guide](./tailscale.md) — registering networks, assigning them to hosts, connection states, security rules
3. [AWS / SSM setup guide](./aws.md) ([한국어](./aws.ko.md)) — prerequisites and example IAM policies for EC2/SSM/ECS features
4. [Self-hosting sync-api](./sync-api-self-hosting.md) — running your own login/sync server, from SQLite to MySQL/OIDC/passkeys
5. [Data protection (E2EE sync)](./data-protection.md) — how sync encryption works, what the server can and cannot see, reset and recovery

## Internals & contributing

- [Architecture](./architecture.md) — runtime boundaries, the SSH/RDP/VNC cores, and key user flows
- [Build and deployment](./build-and-deploy.md) — version policy, release procedure, per-platform builds
- [SSH core IPC protocol](./ipc-protocol.md) — the framed stdio protocol between Electron main and Go ssh-core
- [AI assistant](./ai-assistant-design.md) — providers, context, tools, and security boundaries of the AI panel
