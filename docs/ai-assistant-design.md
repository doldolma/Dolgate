# Dolgate AI Assistant

> Status: guide to the current feature. Covers the providers, context, tools, and security boundaries of the AI panel that works alongside SSH/EC2 sessions.

## Goal

The AI assistant exists to cut copy-paste round trips next to the terminal. The user asks about the current session; the AI explains from the provided host info and terminal output, or runs the needed inspection commands and summarizes the results.

Main use cases:

- Interpreting error logs, command output, and service state
- Read-only diagnostics — disk/memory/ports/containers/logs
- Assisting with changes the user explicitly asks for
- Looking back through old terminal scrollback

## Providers and configuration

AI settings live under desktop **Settings > AI**.

| Provider | Authentication | Notes |
|---|---|---|
| OpenAI-compatible | Base URL + API key | OpenAI, Ollama, LM Studio, vLLM, and so on. Local servers may have no key. |
| Anthropic | Claude API key | Currently connects to the Claude API by API key. |
| Codex | ChatGPT account browser login | Uses a Codex login session with no API key; the model comes from a picker. |

- API keys are stored in the OS keychain and never synced to sync-api.
- Only non-secret settings — base URL, provider, model — are managed as app settings.
- Provider calls and external network egress happen only in the Electron main process. The renderer never sees the keys.

## The panel and context

The AI panel opens to the right of the terminal, one per session. Open and close it with the AI button or `Cmd/Ctrl+I`. It is separate from the terminal input line, so it does not conflict with shell autocomplete, tmux control mode, or ordinary keystrokes.

Default context sent with a question:

- Current session info: tab title, source, connection state
- Host summary: label, kind, address/profile/region/instance info, jump host, mosh, agent forwarding, and so on
- The last 100 lines of terminal output
- Any text the user explicitly attached

Terminal output is frozen as a snapshot at question time. Even if the user produces new output afterwards, the range the AI's tools can read for that question does not shift.

## Tools

When the provider supports tool/function calling, the AI can use the tools below. The Codex provider wires the same tools through a local MCP bridge.

| Tool | Where it runs | Purpose |
|---|---|---|
| `inspect_command` | auxiliary SSH exec channel | Read-only commands for diagnostics and inspection. ~15 second timeout and output length limits. |
| `run_in_terminal` | the active terminal the user is watching | Changes, interactive/streaming/long-running commands, anything the user should see directly. |
| `read_terminal_output` | renderer terminal snapshot | Reads scrollback older than the auto-attached last 100 lines. Default 200, max 500 lines per read. |
| `web_search` | Electron main | Web search, using the configured backend when a search key exists. |
| `fetch_url` | Electron main | Fetches URL content for summarization or analysis. |

Tool selection rules:

- For checking facts, analyzing causes, and inspecting state, `inspect_command` is the default.
- State-changing commands — `systemctl restart`, `docker restart`, `apt install`, file edits, deletions, permission changes, redirects, `sed -i` — go through `run_in_terminal` with user approval.
- Streaming/interactive commands — `tail -f`, `journalctl -f`, `docker logs -f`, `watch`, `top`, editors, REPLs — are never run through `inspect_command`.
- `read_terminal_output` is used only when older terminal output is needed. For current host state, `inspect_command` comes first.

Host exec tools are exposed only when the session has an SSH client. Plain SSH, Warpgate SSH, and EC2 SSH-over-SSM can share the existing SSH connection; sessions without an SSH client, like the raw SSM shell fallback, may have limited execution tools.

## Safeguards and privacy

- Context and tool results pass through secret redaction before reaching the LLM.
- As a baseline rule, passwords, private keys, tokens, cookies, API keys, and connection strings are not exposed in answers.
- Commands that could make changes run only after an approval prompt.
- In-flight responses and tool loops can be stopped with the AI panel's stop button.
- Terminal output, logs, file contents, and web page contents are all treated as untrusted data. Instructions found inside them are not followed unless the user says so explicitly.
- AI tool usage is shown as task status in the AI panel, without flooding the general Logs screen with tool calls.

## Runtime boundaries

| Layer | Role |
|---|---|
| renderer | AI panel UI, conversation state, question-time terminal snapshot, serving older scrollback |
| preload | AI IPC bridge and the main→renderer client tool bridge |
| main | provider adapters, keychain access, the tool loop, external egress, approval/cancel handling |
| ssh-core | exec over the existing SSH client, the visible terminal stream, SFTP/SSM/tmux runtimes |

Because of this structure, API keys and provider network requests never leave main, and only the needed range of renderer-only data like the xterm buffer crosses to main through the client tool bridge.

## Usage flow

1. Enable the AI assistant and configure a provider under Settings > AI.
2. In an SSH/EC2/Warpgate session, open the panel with the AI button or `Cmd/Ctrl+I`.
3. Sending a question includes the current session context and recent terminal output.
4. If more information is needed, the AI checks state with read-only tools and summarizes.
5. If a state-changing command is needed, an approval request is shown; once approved, it runs in the terminal the user is watching.
6. On completion, error, or cancel, the question-bound terminal snapshot and temporary tool state are cleaned up.
