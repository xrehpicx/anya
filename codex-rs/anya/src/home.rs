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

    // SAFETY: this runs at process startup before Anya enters the async runtime
    // and before it spawns worker threads. The embedded Codex crates read
    // CODEX_HOME from the process environment, so setting it once here keeps
    // Anya state under ~/.anya without changing upstream defaults.
    unsafe {
        std::env::set_var(CODEX_HOME_ENV_VAR, &anya_home);
    }

    Ok(anya_home)
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
