use std::path::Path;
use std::path::PathBuf;

use anyhow::Context;
use anyhow::Result;

const ANYA_HOME_ENV_VAR: &str = "ANYA_HOME";
const CODEX_HOME_ENV_VAR: &str = "CODEX_HOME";
const ANYA_HOME_DIR: &str = ".anya";
const LEGACY_CODEX_HOME_DIR: &str = ".codex";

pub fn ensure_anya_home() -> Result<PathBuf> {
    let anya_home = anya_home_path()?;
    std::fs::create_dir_all(&anya_home)
        .with_context(|| format!("create Anya home {}", anya_home.display()))?;
    migrate_legacy_codex_home(&anya_home)?;
    seed_anya_system_skills(&anya_home)?;

    // SAFETY: this runs at process startup before Anya enters the async runtime
    // and before it spawns worker threads. The embedded Codex crates read
    // CODEX_HOME from the process environment, so setting it once here keeps
    // Anya state under ~/.anya without changing upstream defaults.
    unsafe {
        std::env::set_var(CODEX_HOME_ENV_VAR, &anya_home);
    }

    Ok(anya_home)
}

pub fn anya_home_path() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os(ANYA_HOME_ENV_VAR).filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(path));
    }

    let home = dirs::home_dir().context("resolve home directory")?;
    Ok(home.join(ANYA_HOME_DIR))
}

fn seed_anya_system_skills(anya_home: &Path) -> Result<()> {
    seed_anya_system_skill(anya_home, "anya-whatsapp", ANYA_WHATSAPP_SKILL)?;
    seed_anya_system_skill(anya_home, "anya-setup", ANYA_SETUP_SKILL)?;
    seed_anya_system_skill(anya_home, "anya-cli", ANYA_CLI_SKILL)
}

fn seed_anya_system_skill(anya_home: &Path, name: &str, contents: &str) -> Result<()> {
    let skill_dir = anya_home.join("skills").join(name);
    std::fs::create_dir_all(&skill_dir)
        .with_context(|| format!("create Anya skill dir {}", skill_dir.display()))?;
    let skill_path = skill_dir.join("SKILL.md");
    if skill_path.exists() && std::fs::read_to_string(&skill_path).ok().as_deref() == Some(contents)
    {
        return Ok(());
    }
    std::fs::write(&skill_path, contents).with_context(|| format!("write {}", skill_path.display()))
}

fn migrate_legacy_codex_home(anya_home: &Path) -> Result<()> {
    let Some(home) = dirs::home_dir() else {
        return Ok(());
    };
    let legacy_home = home.join(LEGACY_CODEX_HOME_DIR);
    if !legacy_home.is_dir() || legacy_home == anya_home {
        return Ok(());
    }

    for entry in [
        "auth.json",
        "config.toml",
        "sessions",
        "memories",
        "skills",
        "plugins",
        "marketplaces",
        "themes",
        "version",
    ] {
        copy_if_missing(&legacy_home.join(entry), &anya_home.join(entry))?;
    }
    Ok(())
}

fn copy_if_missing(source: &Path, destination: &Path) -> Result<()> {
    if !source.exists() || destination.exists() {
        return Ok(());
    }

    let metadata = std::fs::symlink_metadata(source)
        .with_context(|| format!("read legacy Anya source {}", source.display()))?;
    if metadata.is_dir() {
        copy_dir_if_missing(source, destination)
    } else if metadata.file_type().is_symlink() {
        Ok(())
    } else {
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
        std::fs::copy(source, destination)
            .with_context(|| format!("copy {} to {}", source.display(), destination.display()))?;
        Ok(())
    }
}

fn copy_dir_if_missing(source: &Path, destination: &Path) -> Result<()> {
    std::fs::create_dir_all(destination)
        .with_context(|| format!("create {}", destination.display()))?;
    for entry in std::fs::read_dir(source).with_context(|| format!("read {}", source.display()))? {
        let entry = entry.with_context(|| format!("read entry in {}", source.display()))?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        copy_if_missing(&source_path, &destination_path)?;
    }
    Ok(())
}

const ANYA_WHATSAPP_SKILL: &str = r#"---
name: anya-whatsapp
description: "Use when Anya needs to operate its linked WhatsApp account directly: search known chats or contacts, read recent messages with a person or group, send outbound WhatsApp messages to phone numbers/JIDs/known names, or temporarily listen for replies after Anya initiates a conversation."
metadata:
  short-description: Send and read WhatsApp from Anya
---

# Anya WhatsApp

Use the `anya whatsapp` CLI. These commands talk to the already-running Anya gateway WhatsApp bridge; they do not start a second WhatsApp session.

## Commands

- List known peers: `anya whatsapp contacts --query "<name-or-number>"`
- Read and sync recent messages: `anya whatsapp read --chat "<name-number-or-jid>" --limit 20`
- Read around a specific WhatsApp message ID: `anya whatsapp read --chat "<chat-jid>" --message-id "<message-id>" --around 10`
- Send a message: `anya whatsapp send --to "<number-or-jid-or-known-name>" "message text"`
- Send a file/media item: `anya whatsapp send --to "<peer>" --file "/path/to/file" "optional caption"`
- Send multiple files: `anya whatsapp send --to "<peer>" --file "/path/a" --file "/path/b" "caption for first file"`
- Override media kind when auto-detection is wrong: `anya whatsapp send --to "<peer>" --file "/path/to/file" --media-kind document|image|video|audio|voice "optional caption"`
- Send and temporarily accept replies from that peer: `anya whatsapp send --to "<peer>" --listen-secs 1800 "message text"`
- Open a temporary listen window without sending: `anya whatsapp listen --chat "<peer>" --seconds 900`

## Workflow

1. Resolve the recipient first with `contacts` when the user gives a name. If there are ambiguous matches, ask the user which one to use.
2. Use phone numbers in E.164 form when possible, for example `+15551234567`. The bridge normalizes numbers to WhatsApp JIDs.
3. Before sending sensitive/surprising messages or any file/media item, confirm the exact recipient, file path, and message/caption with the user. This is especially important when sending to a third party.
4. When the user asks whether someone replied, call `read` for that chat. The read command returns the bridge's known messages and attempts an on-demand WhatsApp history sync when it has an anchor message for that chat.
5. If Anya initiates a conversation and expects a reply, use `--listen-secs` on `send` or call `listen`. This temporarily admits inbound messages from that peer even when normal inbound policy would not.
6. When replying from a WhatsApp channel, use the current chat JID from the WhatsApp chat context as the `--to` value to send files back to the same chat.
7. When the prompt says the user replied to a quoted WhatsApp message but only includes a message ID, use `anya whatsapp read --chat "<chat-jid>" --message-id "<message-id>" --around 10` to fetch recorded/synced context around it before answering.

## Limits

The bridge can read messages it has observed or received from WhatsApp history sync. On-demand WhatsApp history requires at least one anchor message in that chat. If `read` returns `sync.reason = "no_anchor_message"`, say that Anya cannot verify old phone-only history for that chat yet; the user may need to re-link WhatsApp after this Anya version so the bridge can request full desktop history.
"#;

const ANYA_SETUP_SKILL: &str = r#"---
name: anya-setup
description: "Use when setting up Anya for first use, checking whether Anya setup is complete, configuring the default working directory, or deciding where Anya should keep self-iteration instructions."
metadata:
  short-description: Configure Anya's first-run setup
---

# Anya Setup

Use the `anya setup` CLI. It records explicit setup confirmation in Anya home, separate from inferred workspace instructions and separate from service health. A running service is not the same as completed setup.

## Commands

- Check first-run setup: `anya setup status --json`
- Persist setup: `anya setup set --default-workdir "<path>" --self-iteration-file "<path>" --confirm`

## Workflow

1. Run `anya setup status --json` before claiming setup is complete. Do this before checking service health when the user asks whether Anya is "set up", "configured", "done setup", or "ready setup".
2. If `complete` is false, ask one setup question at a time. Prefer the `inferredDefaultWorkdir` and `inferredSelfIterationFile` values if present, but ask the user to confirm them.
3. When the user confirms a default work directory and self-iteration file, run `anya setup set --default-workdir ... --self-iteration-file ... --confirm`.
4. After persisting setup, tell the user the configured paths and continue with their task.

## Defaults

If the user accepts the inferred paths, use them. If there are no inferred paths, suggest `~/anya/projects` for project work and `~/anya/ANYA_SELF_ITERATION.md` for Anya self-iteration instructions.
"#;

const ANYA_CLI_SKILL: &str = r#"---
name: anya-cli
description: "Use when Anya needs to operate, inspect, configure, validate, apply, update, or explain its own CLI and service."
metadata:
  short-description: Operate Anya's own CLI
---

# Anya CLI

Use the `anya` CLI for Anya's own service, configuration, sessions, channels, and WhatsApp bridge. Prefer these commands over ad-hoc file inspection when they exist.

## Config Files

- Anya home: `~/.anya`
- Main config: `~/.anya/config.toml`
- First-run setup state: `~/.anya/setup.json`
- Auth: `~/.anya/auth.json`
- Bundled/user skills: `~/.anya/skills`
- WhatsApp config: `~/.local/share/anya/whatsapp/config.json`
- WhatsApp message log: `~/.local/share/anya/whatsapp/message-log.json`

## Config Workflow

- Show paths: `anya config paths --json`
- Validate config: `anya config check --json`
- Apply config like nginx test-and-reload: `anya config apply --json`
- Apply config to a specific user service: `anya config apply --service anya --json`

Always run `anya config check` before applying config. If check fails, do not apply or restart. Fix the reported file first.

## Setup Workflow

- Check first-run setup: `anya setup status --json`
- Persist setup: `anya setup set --default-workdir "<path>" --self-iteration-file "<path>" --confirm`

First-run setup is about the user's chosen default workdir and self-iteration file. Service health, auth, and WhatsApp connection can all be OK while first-run setup is still incomplete.

## Service and Auth

- Check auth through the running gateway: `anya auth status --timeout-secs 60`
- Update installed Anya from the latest release and safely restart the service: `anya update`
- Update and notify a channel after restart: `anya update --notify-channel "whatsapp:<jid>"`
- Update without restarting the service: `anya update --no-restart-service`
- Restart safely from inside Anya: `anya service restart --name anya`
- Print a unit: `anya service print --user "$USER" --binary "$HOME/.local/bin/anya"`

Do not run `systemctl --user restart anya.service` directly from inside Anya. Use `anya service restart --name anya`.
For publishing/release procedure, read `ANYA_PUBLISHING.md` in the Anya repo before cutting or refreshing release assets.

## System Events

- Queue agent follow-up after restart/update: `anya system-event enqueue --channel "whatsapp:<jid>" "Continue after restart: <instruction>"`
- Queue direct notification after restart/update: `anya system-event enqueue --channel "whatsapp:<jid>" --direct "Anya restarted and is back online."`
- List pending events: `anya system-event list --json`
- Drain pending events manually: `anya system-event drain`

Before self-restarting or self-updating while the user expects a follow-up, queue a system event. The gateway drains queued events on startup after the app-server and WhatsApp bridge are reachable.

## Sessions and Models

- Create a channel session: `anya session-create --channel <name>`
- Send to a channel: `anya session-send --channel <name> --wait "message"`
- Steer an active turn: `anya session-steer --channel <name> --turn-id <id> "message"`
- List models: `anya models --format whatsapp`

## WhatsApp

- Contacts/chats: `anya whatsapp contacts --query "<name-or-number>"`
- Read/sync chat: `anya whatsapp read --chat "<name-or-number-or-jid>" --limit 20`
- Read around a message ID: `anya whatsapp read --chat "<chat-jid>" --message-id "<message-id>" --around 10`
- Send: `anya whatsapp send --to "<peer>" "message"`
- Send a file/media item: `anya whatsapp send --to "<peer>" --file "/path/to/file" "optional caption"`
- Force media kind: `anya whatsapp send --to "<peer>" --file "/path/to/file" --media-kind document|image|video|audio|voice "optional caption"`
- Send and temporarily listen: `anya whatsapp send --to "<peer>" --listen-secs 1800 "message"`
"#;
