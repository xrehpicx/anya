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
cargo build -p anya
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
anya channel list
anya rpc model/list
```

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
