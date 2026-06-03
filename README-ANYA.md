# Anya

Anya is a fork of Codex with an additional single-binary agent entrypoint:
`anya`.

The `anya` binary embeds Codex's app server and TUI directly. It reuses Codex's
auth, prompts, model-provider support, tools, MCP support, and session storage,
then adds a smaller service-oriented CLI for running Codex as a background agent
and addressing sessions through named channels.

## Install

Linux and macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/xrehpicx/anya/main/scripts/install/install-anya.sh | sh
```

By default this installs to `$HOME/.local/bin/anya`. Set `ANYA_INSTALL_DIR` to
choose another destination:

```sh
curl -fsSL https://raw.githubusercontent.com/xrehpicx/anya/main/scripts/install/install-anya.sh | ANYA_INSTALL_DIR=/usr/local/bin sh
```

## Build From Source

```sh
cd codex-rs
cargo build -p codex-anya
```

The resulting `target/debug/anya` binary contains the Anya CLI, the embedded
Codex app server, and the embedded Codex TUI.

## Run the Service

```sh
anya serve --listen ws://127.0.0.1:4827
```

## CLI Chat

In another shell:

```sh
anya chat --channel main
```

The `main` channel is persisted as a mapping to a Codex thread ID. Additional
channels can be bound to different threads.

## Codex TUI for the Main Session

`anya tui` opens the existing Codex chat UI through the embedded TUI code. It is
bound to Anya's `main` channel by default, so the same primary session can be
used from the service API, CLI chat, and TUI:

```sh
anya tui
```

Use another channel when needed:

```sh
anya tui --channel ops
```

## Session Commands

```sh
anya session-create --channel main
anya session-send --channel main "inspect this repo"
anya session-send --channel main --wait "reply with pong"
anya channel list
anya rpc model/list
```

## Restart and Update Follow-Ups

Anya can queue persisted system events before it restarts or updates itself.
The gateway drains these events after startup, once the app server and channel
bridges are reachable.

Queue an agent-handled follow-up:

```sh
anya system-event enqueue --channel "whatsapp:<jid>" "Continue after restart: <instruction>"
```

Queue a direct notification:

```sh
anya system-event enqueue --channel "whatsapp:<jid>" --direct "Anya restarted and is back online."
```

For self-updates, a simple post-update notification can be queued directly:

```sh
anya update --notify-channel "whatsapp:<jid>"
```

Inspect or manually drain queued events:

```sh
anya system-event list --json
anya system-event drain
```

## WhatsApp Bridge

Anya can install a small WhatsApp Web bridge based on Baileys. It maps each
WhatsApp chat or group to a persistent Anya channel named
`whatsapp:<whatsapp-jid>`. Direct messages always go to Anya. In groups, Anya
only responds when the message starts with `anya`, `/anya`, `/ask`, or mentions
the bot account.

Guided setup installs the bridge, installs Node dependencies, and starts pairing
in the foreground:

```sh
anya whatsapp setup
```

Use a dedicated WhatsApp number when possible. To pair with a phone-number code
instead of a QR:

```sh
anya whatsapp setup --phone-number +15551234567
```

You can also reach the same flow through the channel command namespace:

```sh
anya channels whatsapp setup
```

After pairing, stop the foreground bridge with Ctrl-C and install it as a user
service:

```sh
mkdir -p ~/.config/systemd/user
anya whatsapp print-service --anya-binary ~/.local/bin/anya > ~/.config/systemd/user/anya-whatsapp.service
systemctl --user daemon-reload
systemctl --user enable --now anya-whatsapp.service
```

For non-interactive provisioning, install only the bridge files:

```sh
anya whatsapp setup --no-run
```

To use it in a WhatsApp group, add the paired WhatsApp account to the group and
send messages such as `anya summarize this chat`.

## Install as a systemd Service

Print a unit:

```sh
anya service print --binary /usr/local/bin/anya --listen ws://127.0.0.1:4827
```

Install a unit:

```sh
sudo anya service install --binary /usr/local/bin/anya --listen ws://127.0.0.1:4827
sudo systemctl daemon-reload
sudo systemctl enable --now anya
```
