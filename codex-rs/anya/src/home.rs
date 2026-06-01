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

fn seed_anya_system_skills(anya_home: &Path) -> Result<()> {
    let skill_dir = anya_home.join("skills").join("anya-whatsapp");
    std::fs::create_dir_all(&skill_dir)
        .with_context(|| format!("create Anya skill dir {}", skill_dir.display()))?;
    let skill_path = skill_dir.join("SKILL.md");
    if skill_path.exists() {
        return Ok(());
    }
    std::fs::write(&skill_path, ANYA_WHATSAPP_SKILL)
        .with_context(|| format!("write {}", skill_path.display()))
}

fn anya_home_path() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os(ANYA_HOME_ENV_VAR).filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(path));
    }

    let home = dirs::home_dir().context("resolve home directory")?;
    Ok(home.join(ANYA_HOME_DIR))
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
description: Use when Anya needs to operate its linked WhatsApp account directly: search known chats or contacts, read recent messages with a person or group, send outbound WhatsApp messages to phone numbers/JIDs/known names, or temporarily listen for replies after Anya initiates a conversation.
metadata:
  short-description: Send and read WhatsApp from Anya
---

# Anya WhatsApp

Use the `anya whatsapp` CLI. These commands talk to the already-running Anya gateway WhatsApp bridge; they do not start a second WhatsApp session.

## Commands

- List known peers: `anya whatsapp contacts --query "<name-or-number>"`
- Read recent recorded messages: `anya whatsapp read --chat "<name-number-or-jid>" --limit 20`
- Send a message: `anya whatsapp send --to "<number-or-jid-or-known-name>" "message text"`
- Send and temporarily accept replies from that peer: `anya whatsapp send --to "<peer>" --listen-secs 1800 "message text"`
- Open a temporary listen window without sending: `anya whatsapp listen --chat "<peer>" --seconds 900`

## Workflow

1. Resolve the recipient first with `contacts` when the user gives a name. If there are ambiguous matches, ask the user which one to use.
2. Use phone numbers in E.164 form when possible, for example `+15551234567`. The bridge normalizes numbers to WhatsApp JIDs.
3. Before sending sensitive or surprising messages, confirm the exact recipient and text with the user.
4. When the user asks whether someone replied, call `read` for that chat. The read command returns the bridge's recent recorded messages, including messages received while the gateway was running and outbound messages sent through this skill.
5. If Anya initiates a conversation and expects a reply, use `--listen-secs` on `send` or call `listen`. This temporarily admits inbound messages from that peer even when normal inbound policy would not.

## Limits

The bridge can read the recent message log it recorded while connected. It is not a full phone backup extractor and may not have old WhatsApp history from before Anya's bridge observed or sent messages.
"#;
