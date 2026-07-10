# Privacy Policy

_Last updated: 2026-07-10_

Dolgate is a local-first SSH client. **It collects no telemetry, no analytics, no crash reports, and shows no ads.** The list below is everything the app stores or transmits.

- **On your device.** Hosts, snippets, logs, and session replays are stored locally. Passwords, private keys, and AI API keys are encrypted with the OS secure storage (Keychain / DPAPI / libsecret); if secure storage is unavailable, the app refuses to save secrets.
- **Connections.** SSH/SFTP/Mosh traffic goes directly from your device to the servers you configure, end-to-end encrypted by SSH. AWS features use the AWS credentials already on your machine.
- **Account & sync (optional).** Signing in connects to the sync server chosen on the sign-in screen — the maintainer-operated default, or your own self-hosted instance (the server is open source in this repository). It stores your email and your workspace records; records are encrypted on-device (AES-256-GCM) before upload.
- **AWS server proxy & session sharing (optional).** With the server proxy enabled, the app sends the sync server short-lived AWS session credentials so the server can open the SSM session for that connection; the relayed traffic is end-to-end encrypted SSH and is not stored. Session sharing relays the shared terminal to the participants you invite.
- **AI (optional).** Your API key stays in OS secure storage; prompts (including any terminal context you invoke it on) go directly from your device to the provider you configured.
- **Updates.** The desktop app checks GitHub Releases; GitHub sees standard request metadata.

**Deletion.** Local data is fully under your control. Deleting synced records propagates to your sync server, and you can delete your account and its stored data from the app.

Questions or requests: <https://github.com/doldolma/dolgate/issues>
