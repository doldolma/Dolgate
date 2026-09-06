# Dolgate Desktop

Dolgate Desktop is an Electron-based SSH and remote desktop workspace for Windows, macOS, and Linux.
Its central role today is handling terminal and remote screen sessions in one UI — together with file transfer, port forwarding, session sharing, and AWS/container work.

## Current features

- Multi-session terminals with a tab-based workspace
- RDP remote desktops with multi-monitor layouts, audio, clipboard, and local folder sharing
- VNC remote desktops with view-only mode, image quality controls, clipboard, and SSH tunneling
- tmux control mode integration (remote windows → tabs, panes → split workspace, detach supported)
- mosh connections (UDP-based, resilient to switching networks and sleep/wake)
- Command autocomplete (Fig specs + generators + paths + snippets)
- Command snippets (variables supported, wired into autocomplete and a management UI)
- OS notifications on command completion (for long-running or failed commands, via shell integration)
- Command blocks (shell-integration based: dot markers, hover actions, sticky header, command palette)
- AI assistant (session-context questions, inspect/run tools, provider choice)
- Dual-panel SFTP browser and file transfer
- Terminal file transfer (drag SFTP upload / remote `sz` ZMODEM download)
- Built-in editing of remote SFTP files (in-app text editing and save, conflict detection, sudo save)
- SSH Agent authentication (1Password / `ssh-add` / OS ssh-agent)
- SSH Agent Forwarding (`ssh -A` style; recommended only on trusted hosts)
- Jump host (bastion) connections (ProxyJump / `ssh -J`)
- Tailscale / Headscale built in (the app joins as a tailnet node — no OS client, no VPN permissions)
- Local / Remote / Dynamic port forwarding
- Session recording and replay (stored locally, never synced to the server)
- Session Share with a browser viewer and live chat
- AWS EC2 import, EC2 SSH-over-SSM, Windows RDP over SSM, SSM shell fallback, AWS SFTP, SSM port forwarding, ECS Exec shell, ECS tunneling
- Docker / Podman container monitoring, logs, metrics, shells, tunneling
- Host export (encrypted Dolgate file · OpenSSH config), including RDP/VNC hosts in the Dolgate format, and Dolgate file import
- OpenSSH / Xshell / Termius import
- Passkey (WebAuthn) login and passkey management (when enabled on the server)
- Update distribution via GitHub Releases

## RDP and VNC remote desktops

RDP and VNC hosts open as full workspace tabs alongside terminal sessions. Remote desktop sessions are available in the desktop app only; they use the full workspace rather than terminal split panes so that text and controls remain readable.

### RDP

- **Multi-monitor**: use one display or select multiple local displays (up to the RDP protocol limit of 16). The remote monitors can stay together in the main workspace or be spread into one window per local display, then collapsed back into the main window.
- **Display and input**: the remote resolution follows the available window size. Keyboard and pointer input go to the remote session while its canvas is focused.
- **Redirection**: remote audio and text clipboard synchronization are enabled by default. One or more local folders can be exposed as remote drives, individually marked read-only when needed.
- **Connection routes**: connect directly, through the built-in Tailscale/Headscale node, or to a Windows EC2 instance through an AWS SSM port-forwarding session. The RDP server name remains the identity used for certificate verification even when a loopback forward carries the traffic.
- **Server trust**: most RDP servers use self-signed certificates, so the first connection asks you to verify the SHA-256 fingerprint before credentials are sent. The accepted fingerprint is pinned to the host (TOFU), synced with the encrypted host record, and can be revoked under Settings > Security.
- **Other options**: reusable `DOMAIN\user` credentials, admin sessions, 16/32-bit color, automatic reconnect, and manual screen refresh.

### VNC

- **Connection routes**: connect directly, through a tailnet, or through a saved SSH host. The SSH tunnel reuses that host's authentication, jump chain, host-key trust, and tailnet route; OTP and trust prompts appear over the VNC connection screen when needed.
- **Session behavior**: choose whether to share the server with other VNC clients or request an exclusive session, and enable view-only mode to prevent accidental keyboard or pointer input.
- **Display and transfer**: choose lossless, balanced, or fast image quality; synchronize text through the clipboard; and request the current window size when the VNC server supports desktop resizing.
- **Protocol limits**: VNC exposes one framebuffer and has no RDP-style audio, drive redirection, or negotiated multi-monitor layout.

Both protocols participate in the regular connection progress UI, activity log, recent-host tracking, and automatic reconnect behavior. Passwords and related host settings follow the same encrypted storage and E2EE sync rules as SSH credentials.

## Command autocomplete

While you type in the terminal, it suggests commands, options, paths, and dynamic values (container names, git branches, and so on). Toggle it under Settings > General with **Command autocomplete**; the default is on.

- **When it activates**: only in sessions where shell integration (OSC 133) is detected. On connect, prompt markers are injected into bash/zsh so prompt boundaries can be recognized; once markers are confirmed, suggestions start. (Works on SSH / local / AWS SSM whenever integration succeeds.)
- **Suggestion sources**
  - Executable names (remote `$PATH`) and shell history
  - **Fig-spec** options and subcommands — converted from withfig/autocomplete, shown even if you have never typed them
  - **File/folder paths** — for `cd`/`ls`/`cat` and the like, suggested by actually listing the current directory. For path arguments, the real filesystem wins over stale history paths
  - **Generator dynamic values** — real values fetched by running read-only commands on the host, as in `docker logs <container>` or `git checkout <branch>`
  - **Snippets** — saved commands matched by keyword (or label) prefix, inserting the full command (variables `{{name}}` are filled in at insert time)
- **How dynamic completion works**: SSH/local sessions run short commands over an auxiliary channel (a separate SSH exec / local subprocess) to fetch values, cached per prompt (refreshed when a command runs; further typing in the same directory filters without re-querying). AWS SSM has no auxiliary channel, so it degrades to static suggestions + history without dynamic values.
- **Keyboard**: `↓`/`↑` to move, `Tab` or `→` to select, `Enter` selects the arrow-highlighted item (or runs the command when at the top), `Esc` to close.

The generator execution engine is ported from the generator runtime of Amazon Q Developer CLI (the open-source successor to Fig, Apache-2.0/MIT), changed to run **on the remote host** over our auxiliary channel instead of locally. Bundled specs/generators are produced with `npm run generate:specs` (`apps/desktop/src/renderer/generated/command-specs*`, withfig/autocomplete MIT).

### Scoring

Each candidate gets **a per-source base score + bonuses**; identical results are merged at the higher score (dedup), keeping **the top 20 by score**. The overlay shows **5 at a time**; arrow keys (↓/↑) scroll the rest. Suggestions start from **2 characters** and only when the cursor is at the end of the line.

Base scores by source:

| Source | Overlay label | Base score |
|---|---|---|
| Saved snippet — keyword/label **exact match** | Snippet | `20000` (top) |
| Executables (remote `$PATH`) | Command | `6000 − length` |
| Commands run this session (full line) | History | `4500` + bonuses |
| Saved snippet — keyword/label prefix match | Snippet | `4000` |
| File/folder paths | Path | `2000 − length` |
| Generator dynamic values | Value | `1800 − length` |
| Saved snippet — keyword/label substring match | Snippet | `1500` |
| Fig-spec options and subcommands | Spec | `1000` |
| `~/.bash_history` lines | History | `150` + bonuses |

Bonuses (applied only to history/full-line entries):

| Bonus | Value | Condition |
|---|---|---|
| recency | up to `+550` | the more recent, the larger the bonus (ratio 0–1) |
| frequency | `+350 × log₂(1+count)` | the more often used |
| exitSuccess | `+1500` | exited 0 in this session |
| cwdMatch | `+2000` | this session + same directory |

Additional rules:

- Commands that **failed (exit ≠ 0)** in this session are excluded from suggestions.
- For **path arguments** (`cd`/`ls`, and so on), raw full-line history suggestions are suppressed so the real filesystem (Path) wins — stale history paths do not leak through.
- Raw history is deliberately weak (150) so that only very frequently used lines (count ~20+) rise above Path/Value.

The weight constants are tuned in one place: `SCORE_WEIGHTS` in `apps/desktop/src/renderer/lib/terminal-autocomplete.ts`.

## Command completion notifications

When a long-running or failed command finishes, a native OS notification tells you. Command boundaries, durations, and exit codes come from shell integration (OSC 133), the same as command autocomplete, so it works in sessions where integration is detected (SSH / local / AWS SSM).

- **Where to configure**: the **Notifications** group under Settings > General.
  - **Command completion notifications**: feature on/off. Turning it on requests OS notification permission if undecided.
  - **Notification threshold (seconds)**: notify when a command takes at least this long. (Default: 30 seconds)
  - **Only notify when inactive**: no notification if the app is focused and that session is the active tab (that is, you are already looking at it). (Default: on)
  - **Always notify on failed commands**: notify regardless of duration when the exit code is non-zero. (Default: off)
  - **Sound**: notification sound on/off.
- **What it shows**: the title is the host label, the body is `command · done/failed (exit N) · duration`. Clicking the notification brings the app window back to the front.
- The show/hide decision (threshold, failure, focus) is made in the renderer; actually displaying the OS notification is the job of the notification service in Electron main.

## Command blocks

Each command you run is recognized as a "block", with a thin layer of indicators and actions on top of the terminal screen. Output is not reconstructed into cards — the terminal rendering stays as-is, so the feel of using a shell does not change. Command boundaries, exit codes, and durations come from shell integration (OSC 133), the same as completion notifications.

- **When it activates**: only in sessions where shell integration (OSC 133) is detected. (SSH / local / AWS SSM all work once integrated.) Inside alternate-screen programs (vim, htop, and so on) command boundaries do not exist, so nothing is shown.
- **Dot markers**: one dot in the left gutter of the command line shows the state — running / succeeded / failed. Success uses low saturation so the screen stays quiet.
- **Hover actions**: hovering over a block softly highlights its range, with a status chip (exit code · duration) and a toolbar at the top right.
  - **Copy output** — copies only that command's output (lines soft-wrapped by screen width are restored to single lines).
  - **Copy command** / **Re-run**
  - **AI** — asks the AI panel with that command and output as context. For failed commands, it asks for the cause and a fix. (Shown only when the AI assistant is enabled.)
- **Sticky header**: when you scroll into long output and the command line leaves the top of the screen, a header pinned to the top shows which command the visible output belongs to. Clicking it returns to that command line.
- **Shortcuts**
  - `Cmd/Ctrl+↑` / `Cmd/Ctrl+↓` — jump to the previous / next command
  - `Cmd/Ctrl+Shift+↑` / `Cmd/Ctrl+Shift+↓` — jump to the previous / next **failed** command
  - `Cmd/Ctrl+Shift+P` — command palette
- **Command palette**: searches the commands run in this session. Unlike the shell's `Ctrl+R` history, it shows not just "what you typed" but success/failure, exit code, duration, and working directory — and can filter to **failures only**. `Enter` jumps to that command's output; `Cmd/Ctrl+Enter` re-runs it.

**Limits of re-run** — shell integration does not report the command text itself, so commands are recovered **by reading what was drawn on screen**. In the following cases the recovered text may differ from what was actually typed, so re-run is blocked and the palette marks it `not re-runnable`:

- The command exceeded 20 rows and was truncated — the truncated prefix may itself be a valid command (for example an `rsync` whose `--dry-run` was cut off), which would be dangerous to send as-is.
- Multi-line input via `\` continuation or heredocs.

With a zsh right prompt (RPROMPT), it is drawn on the same row and can bleed into the command text. Display and copy still work; only re-run is blocked.

## AI assistant

In the AI panel to the right of the terminal, you can ask about the current session, and when needed the AI can inspect host state through tools or run commands in the terminal you are watching. Open and close the panel with the AI button or `Cmd/Ctrl+I`; it persists per session tab. It is separate from the terminal input area, so it does not conflict with autocomplete or tmux handling.

- **Providers**: OpenAI-compatible APIs (OpenAI, Ollama, LM Studio, vLLM, and so on), the Anthropic Claude API, and Codex (ChatGPT account login). OpenAI-compatible/Anthropic store the API key in the OS keychain; Codex uses a browser login session with no API key.
- **Automatic context**: the host summary at the time of the question, current session info, and the last 100 lines of terminal output are sent along. If older output is needed, the AI can read further ranges from a scrollback snapshot frozen at question time.
- **Tools**: `inspect_command` performs read-only queries over a hidden SSH exec channel; `run_in_terminal` types a command into the terminal you see. Web search and URL reading are available independently of the provider.
- **Safeguards**: context and tool results pass through secret redaction, and commands that could make changes run only after user approval. In-flight responses and tool loops can be stopped with the panel's stop button.
- **Constraints**: host exec tools are exposed only when the session has an SSH client. Plain SSH, Warpgate SSH, and EC2 SSH-over-SSM share the same SSH connection; paths without an SSH client, like the raw SSM shell fallback, may have limited execution tools.

The design (context composition, provider egress boundaries, tool safeguards) is written up in [ai-assistant-design](./ai-assistant-design.md).

## SSH Agent authentication and forwarding

Choosing **Auth Type = SSH Agent** in the host create/edit window authenticates through your local ssh-agent without storing a password or key file in Dolgate. It can use `SSH_AUTH_SOCK` on macOS/Linux, launchctl agents, the Windows OpenSSH agent, the 1Password SSH Agent, and keys registered via `ssh-add`.

- **Status check**: selecting SSH Agent authentication shows whether the local agent is reachable and how many keys it holds, right in the settings screen.
- **Storage model**: agent authentication delegates signing to the local agent, so the private key itself is never stored in Dolgate's storage or sync-api.
- **Agent Forwarding**: enabling **SSH Agent Forwarding** on SSH and AWS EC2 hosts lets you use local keys when hopping from the remote host to further servers. It behaves like `ssh -A`, so enable it only on hosts you trust.
- **Constraint**: mosh connections do not support agent forwarding, so the toggle is disabled there.

## Jump hosts (bastions)

Connect to hosts you cannot reach directly — hosts on private subnets, for example — **via an intermediate bastion (SSH server)**. It uses standard SSH `direct-tcpip` forwarding (`ssh -J`), so the bastion only needs a plain sshd; everything happens in the client (`ssh-core`), with sync-api uninvolved.

- **Setup**: in the host create/edit window's Connection section, pick **another saved SSH host** as the bastion in the **Jump host** selector. The bastion's credentials and known-host entries are reused from that saved host.
- **Scope**: terminal · SFTP · port forwarding · containers — all four connection types route the same way. (The jump is injected at `sshconn.DialClient`, the single dial point every connection passes through.)
- **Trust (TOFU)**: the bastion is trusted first, then the target's host key is probed **through the trusted bastion**. If the bastion is not yet trusted, a fingerprint prompt appears automatically before proceeding. Keys of targets behind the bastion (unreachable directly) can be verified and trusted through this relayed probe.
- **Authentication**: the bastion can use password / privateKey / certificate / keyboard-interactive (the two hops authenticate in sequence). However, the **key probe** through a bastion supports non-interactive auth only (password/key/certificate).
- **Multi-hop chains**: multiple jump hosts can be listed in order from the top. The first hop is the bastion the client dials directly; the last hop sits just in front of the target.
- **Constraint**: only a plain SSH host can serve as a jump host; AWS-SSM/Warpgate hosts cannot be used as jumps.

## Tailscale / Headscale (tailnet)

A tailnet node lives inside the app, so you can reach hosts inside a tailnet **without installing Tailscale or granting VPN permissions**. The OS routing and DNS are untouched. Register several tailnets (work, customer, home) side by side and choose per host which one to go through.

- **Registration**: add under Settings > **Tailscale**. Enter a name, a Headscale server address (empty = the default Tailscale server), and an auth key; it saves once the **connection test** passes. After joining, it also shows which account joined which tailnet.
- **Authentication**: with an auth key, registration happens without a browser. Leave it empty and a browser opens automatically as soon as the auth link is ready. Nodes registered with an auth key are cleaned up by the control plane when unused; nodes registered via browser login persist.
- **Assigning hosts**: choose in the **Tailnet** selector in the host create/edit window's Connection section. The *Manage* link next to it jumps straight to the Tailscale section in Settings.
- **Scope**: shell · tmux · mosh · SFTP · containers · port forwarding · RDP · VNC, and **SSH host key verification too**, all leave through the tailnet. mosh routes both the bootstrap SSH and the UDP session through it; RDP and VNC use session-scoped loopback forwards so their Rust sidecars do not alter OS routing or DNS.
- **First connection**: you do not have to pre-connect in Settings — the node comes up when you connect to a host. So **only the first connection takes a few seconds**; after that it is instant. One node is shared per tailnet and stays up for 30 minutes after the last connection ends. Tailnets that require browser login must be authenticated in Settings first.
- **When sync is lost**: even if synchronization with the control plane (map poll) drops, **connections are still attempted**. Existing routes keep working from the already-received device list — what broke is the update channel (Tailscale itself does not warn about this state for 8 minutes). It waits briefly and moves on, leaving a warning on the *control plane sync* step of the connection screen — shown as **sync lost** in Settings. If the host truly cannot be reached, the reason appears at the next steps (routing/SSH).
- **Host key trust**: a trusted key is valid **only within that tailnet**. The same name on a different tailnet is a different machine. Right before connecting, the actually-joined tailnet is compared against the stored one — if they differ, the connection is refused.
- **Route display**: hover a tab to see the tailnet name and the current path (**direct** or **via relay + DERP region**) with latency. Starting on a relay right after connecting and switching to direct shortly after is normal.
- **Per-device registration**: tailnets are registered **per device**. Settings and auth keys sync encrypted (the server sees only ciphertext), but a device's node key never syncs. The node appears in device lists as `dolgate-<device name>`.
- **Constraints**: cannot be combined with AWS EC2's server proxy (both take over the connection to the target). Hosts pointing at a tailnet that was deleted in Settings are refused — otherwise the connection would silently go outside the tailnet.
- **Performance**: it uses an in-app network stack, so bulk-transfer throughput is lower than with the OS client. Latency is dominated by the path, so once a direct connection is established the difference is negligible.

The full guide — registration, connection states, security rules — is in the [Tailscale / Headscale guide](./tailscale.md).

## Login and offline use

Sign in through the browser opened by Dolgate, then return to the app. To use your own login and sync server, change **Login Server** through the gear icon on the login screen; see the [self-hosting guide](./sync-api-self-hosting.md#connecting-the-desktop-app).

If the login server is unavailable, a previously signed-in app can continue using its saved hosts and settings while its offline authorization remains valid. Sync retries in the background when the server becomes reachable. If the offline authorization has expired, sign in again with the server available. Connecting to a host still requires a working network route to that host.

## Passkey (WebAuthn) login

Sign in with biometrics or a security key instead of a password. It appears **only when the sync server has it enabled** (for self-hosting see the [setup guide](./sync-api-self-hosting.md#passkey-webauthn-login)) and coexists with password and OIDC login.

- **Signing in**: use the **Sign in with a passkey** button on the browser login screen, or pick the passkey the browser suggests at the input field.
- **Adding and managing**: add and delete passkeys under Settings > **Account** > **Passkeys** (the list updates once registration completes in the browser). There is a cap on the number of registrations.
- **Caution**: passkeys are bound to the registered domain, so a changed server address requires re-registration — and they **do not replace the sync passphrase** (entered separately after login).

## Host export · import

Right-click a host or group in the host list and choose **Export...** to save it to a file together with everything the connection needs. Desktop only.

- **Formats**: **Dolgate file (`.dolgate`)** — contains credentials and related settings, including RDP/VNC credentials and the SSH host needed by a VNC tunnel, fully encrypted with an export passphrase (4+ characters; Argon2id + AES-256-GCM). **The passphrase is unrecoverable.** / **OpenSSH config** — plaintext, credentials excluded; hosts that cannot be expressed (including RDP/VNC) are counted and skipped.
- **Importing a Dolgate file**: pick the file and enter the passphrase to preview what will come in; the import is applied only when you confirm. Existing items are skipped; items with name collisions are imported under a new name and reported.
- **Importing from other apps**: the host list's import menu also reads **OpenSSH · Termius · Xshell (Windows only) · Warpgate · AWS SSM · serial**.

### AWS EC2 import and SFTP

1. Open AWS import and choose an AWS profile. Complete browser login if the profile requires it.
2. If the profile has a default region, Dolgate selects it and loads the instance list. Otherwise, choose a region to load its instances.
3. Select a Linux instance. **Check SSH info** can suggest the SSH username and port; you can edit the values or enter them manually. You can also save the host and fill in the SSH details later.

AWS SFTP needs a Linux instance managed by SSM, a working SSH/SFTP server, and EC2 Instance Connect. The connection screen shows progress through AWS authentication, instance checks, host-key verification, and SSH setup. If the suggested SSH username or port is wrong, edit it and retry.

See the [AWS / SSM setup guide](./aws.md) ([한국어](./aws.ko.md)) for instance setup and permissions, including the optional permissions used by **Check SSH info**.

### Warpgate import

Choose Warpgate in the host import menu, enter its URL, and sign in through the authentication window. After login, Dolgate loads the available targets for import. If you cancel login, the import dialog stays open so you can edit the URL or try again.

## Command snippets

Save frequently used commands and pull them up in the terminal. Add/edit/delete in the sidebar **Snippets** section; like hosts and groups, they are included in encrypted cloud sync.

- **Autocomplete integration**: input matches `keyword`/label by **exact match (20000, top) → prefix (4000) → substring (1500)**, and selecting a candidate clears the current line and inserts the **full command** (you press Enter to run). Exact matches rank above everything; prefix matches rank below commands run this session; substring matches sit in a lower discovery tier. Both keyword **and** label are matched, so label words work too. Only single-line snippets surface in autocomplete.
- **Variables**: put `{{name}}` or `{{name=default}}` in a command and an input modal appears at insert time to substitute values.
- **Stored fields**: label (display name), keyword (for autocomplete matching, optional), command (multi-line allowed).

## Editing remote files over SFTP

Double-click a remote text file in the SFTP panel, or right-click → **Edit**, and an in-app code editor (CodeMirror) opens. The file is read into memory with no separate download; saving writes straight back to the remote.

- **What opens**: text files up to the configured size limit (default 5MB). Binary and oversized files are excluded. (`ssh-core` makes the final call on binary by checking the file's leading bytes for NUL.)
- **Saving**: `Cmd/Ctrl+S`. A temp file is written in the same directory and swapped in atomically (temp + rename), so a mid-write failure never corrupts the original; permissions and modification time are preserved.
- **Conflict detection**: the size and mtime at open time are snapshotted and compared against the remote just before saving. If the file changed in between, you choose *reload* or *overwrite*.
- **sudo save**: files you lack permission for (for example root-owned) can be saved with `sudo` after entering the sudo password. The password is passed via stdin only, never in the command string.
- The maximum editable size is adjusted under Settings > SFTP, **Editor Max File Size (MB)**.

## tmux control mode

tmux normally has a high barrier to entry — everything runs through prefix keystrokes in the terminal. Dolgate shows remote tmux windows as top tabs and panes as split views, driven by mouse (clicks, border drags) or the familiar `Ctrl-b` shortcuts. You can use tmux sessions without memorizing keybindings, and since the server session stays alive on disconnect (detach), reattaching picks up where you left off.

Choose **Connect with tmux** in a host's right-click menu to attach in tmux control mode (`tmux -CC`). It uses your regular SSH credentials; the remote only needs tmux installed.

- **Operations**: new windows, horizontal/vertical splits, window/pane selection, rename, and kill — all directly in the app, with changes syncing both ways with the server tmux.
- **Keyboard shortcuts**: operate mouse-free with **tmux prefix shortcuts** (a setting, on by default). After the prefix: arrows (pane focus), `Ctrl+arrows` (resize), `c` (new window), `%`/`"` (split), `n`/`p`/digits/`l` (switch window), `w` (window list), `z` (zoom), `{`/`}` (swap), `!` (break), `Space` (layouts), `x`/`&` (kill), `[`/`]` (copy/paste), `,`/`$` (rename), `:` (command prompt), `d` (detach). The prefix defaults to `Ctrl-b` and can be changed to `Ctrl-a`/`Ctrl-Space` and others in Settings. Unmapped keys pass through to tmux unchanged.
- **Close = detach**: a tab's `×` detaches rather than kills, so the remote session stays alive — connect with tmux again and it continues.
- **Per-version behavior**: **2.6 and later** attach in GUI control mode, with the input method handled automatically per version (`send-keys -l` for 2.6–3.0, the faster `-H` hex for 3.0a+). Nothing to configure for older servers. **Below 2.6**, control mode lacks the size model, so instead of GUI integration tmux runs in a plain SSH shell (passthrough).
- **Constraints**: SSH hosts only · cannot be combined with jump hosts.

## mosh connections

After a one-time SSH bootstrap, the connection switches to **UDP** — surviving network switches (Wi-Fi↔cellular) and sleep/wake without dropping.

- **Usage**: turn on the **Connect with Mosh** toggle in the host create/edit window and connect as usual.
- **Flow**: SSH starts `mosh-server` on the remote → receives `MOSH CONNECT <port> <key>` and opens the UDP session → the bootstrap SSH closes. I/O then flows over UDP.
- **Status display**: the terminal's bottom bar shows **connected / reconnecting (last response N seconds ago) / disconnected** (~4s silence → reconnecting, 12s → disconnected).
- **Prerequisites**: `mosh-server` installed on the remote, a UTF-8 locale there, and an **open UDP port**. mosh uses one port in UDP 60000–61000, separate from the SSH port — with only SSH open it looks connected but never gets responses.
- **tailnet**: if the host has a tailnet assigned, the UDP session also leaves through that tailnet, so no firewall UDP port needs opening.
- **Constraints**: cannot be combined with jump hosts (bastions) — UDP cannot be proxied, so with a jump configured it automatically falls back to plain SSH. keyboard-interactive auth is unsupported.

## Terminal file transfer

Two paths for moving files **directly in the terminal**, without opening the SFTP panel — local drag-and-drop upload, and remote `sz` (ZMODEM) download.

- **Drag upload (SFTP)**: drop local files onto a connected terminal (SSH / AWS EC2 / Warpgate) and they upload via SFTP into that session's **current working directory** (or the home directory if it cannot be determined). Progress appears as a toast at the bottom right; folder (directory) uploads are not supported.
- **ZMODEM download**: run `sz <file>` on the remote and the ZMODEM transfer is auto-detected in the terminal stream and saved to the **local Downloads** folder (with an *Open folder* button on completion).
- **Limits**: ZMODEM downloads go up to **512MB**; beyond that it stops with a message recommending SFTP. `rz` (ZMODEM upload) is not supported — use drag upload instead.
- **Layering**: drag upload is handled by the renderer as an SFTP transfer job (`sftp:start-transfer`); ZMODEM is detected in the stream by the renderer and saved to Downloads by Electron main.

## Session recording and replay

When a terminal session ends, its I/O and screen size changes are kept as local replay data for later viewing. The replay window offers play/pause, scrubbing, speed control, and zoom.

- **Storage**: session replays live only in the desktop's local storage and are never synced to sync-api.
- **Retention**: adjust how many finished session replays are kept locally under Settings > General, **Session Replay Retention**.
- **Command list**: if the recording had shell integration, a list of executed commands appears on the right. Clicking an entry jumps to the moment that command ran. A handle between the terminal and the list collapses it for a wider view.
- **Timeline ticks**: command positions are marked on the scrubber, with failed commands distinguished by color and length — you can see roughly where things happened before scrubbing. Hovering a tick shows the command at that point.
- **Use cases**: incident investigation, reviewing your own work, and checking the screen flow before handing it to someone else. For live sharing, use Session Share.

## Session Share

Start a share from a terminal session to create a viewer link. Send that link to participants so they can join from a browser.

- **Access**: choose read-only mode or allow viewers to send terminal input.
- **Viewer chat**: the browser viewer includes a chat panel, initially collapsed. Open it to chat with the session owner and other participants.
- **Owner chat**: incoming messages appear as notifications at the bottom right. Use **Chat history** to open the conversation in a separate window.
- **Ending the session**: viewer connections close and the share's chat history is cleared when the shared session ends.

For recordings you can revisit later, see [session recording and replay](#session-recording-and-replay).

## Related guides

- To run the app locally or create your own build, see [building from source](./build-from-source.md).
- AWS/SSM operational prerequisites and example IAM permissions are in the [AWS / SSM setup guide](./aws.md).
- To run your own login and sync server, see the [self-hosting guide](./sync-api-self-hosting.md).
