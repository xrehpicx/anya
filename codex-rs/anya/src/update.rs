use std::path::Path;
use std::path::PathBuf;
use std::process::Stdio;

use anyhow::Context;
use anyhow::Result;
use clap::Args;
use tokio::process::Command;

use crate::service;
use crate::system_events;

const DEFAULT_REPO: &str = "xrehpicx/anya";
const DEFAULT_RELEASE: &str = "latest";
const INSTALLER_PATH: &str = "scripts/install/install-anya.sh";

#[derive(Debug, Args)]
pub(crate) struct UpdateArgs {
    /// GitHub repository to update from, in OWNER/REPO form.
    #[arg(long, default_value = DEFAULT_REPO)]
    pub(crate) repo: String,

    /// Release tag to install, or "latest".
    #[arg(long, default_value = DEFAULT_RELEASE)]
    pub(crate) release: String,

    /// Install directory. Defaults to the current anya binary's directory, then ~/.local/bin.
    #[arg(long)]
    pub(crate) install_dir: Option<PathBuf>,

    /// Allow the installer to build from source when a binary release asset is missing.
    #[arg(long)]
    pub(crate) source_fallback: bool,

    /// Do not restart the user systemd service after updating the binary.
    #[arg(long)]
    pub(crate) no_restart_service: bool,

    /// User systemd service name to restart after the update.
    #[arg(long, default_value = "anya")]
    pub(crate) service_name: String,

    /// Queue a post-update notification for this channel, e.g. whatsapp:<jid>.
    #[arg(long)]
    pub(crate) notify_channel: Option<String>,

    /// Message to send when --notify-channel is used.
    #[arg(long, default_value = "Anya update completed.")]
    pub(crate) notify_message: String,
}

pub(crate) async fn run(args: UpdateArgs) -> Result<()> {
    let install_dir = args.install_dir.unwrap_or_else(default_install_dir);
    let tmp_dir = make_temp_dir().await?;
    let installer_path = tmp_dir.join("install-anya.sh");
    let installer_url = installer_url(&args.repo);

    download_installer(&installer_url, &installer_path)
        .await
        .with_context(|| format!("download Anya installer from {installer_url}"))?;

    println!(
        "Updating Anya from {repo} release {release} into {install_dir}",
        repo = args.repo,
        release = args.release,
        install_dir = install_dir.display()
    );

    let mut command = Command::new("sh");
    command
        .arg(&installer_path)
        .arg("--repo")
        .arg(&args.repo)
        .arg("--release")
        .arg(&args.release)
        .env("ANYA_INSTALL_DIR", &install_dir)
        .env(
            "ANYA_BINARY_ONLY",
            if args.source_fallback { "0" } else { "1" },
        )
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    let status = command
        .status()
        .await
        .with_context(|| format!("run {}", installer_path.display()))?;

    tokio::fs::remove_dir_all(&tmp_dir).await.ok();

    if !status.success() {
        anyhow::bail!("Anya update installer failed with status {status}");
    }

    if let Some(channel) = args.notify_channel {
        let event =
            system_events::enqueue_direct_notification(channel, args.notify_message).await?;
        println!("Queued post-update system event {}.", event.id);
    }

    if args.no_restart_service {
        println!("Anya update complete. Restart anya.service when you want the service to use it.");
        return Ok(());
    }

    service::restart_user_systemd_unit(&args.service_name).await?;
    println!("Anya update complete.");
    Ok(())
}

fn installer_url(repo: &str) -> String {
    format!("https://raw.githubusercontent.com/{repo}/main/{INSTALLER_PATH}")
}

fn default_install_dir() -> PathBuf {
    if let Ok(current_exe) = std::env::current_exe()
        && let Some(parent) = current_exe.parent()
    {
        return parent.to_path_buf();
    }

    dirs::home_dir()
        .map(|home| home.join(".local/bin"))
        .unwrap_or_else(|| PathBuf::from("."))
}

async fn make_temp_dir() -> Result<PathBuf> {
    let tmp_dir = std::env::temp_dir().join(format!(
        "anya-update-{}-{}",
        std::process::id(),
        unix_timestamp_millis()
    ));
    tokio::fs::create_dir_all(&tmp_dir)
        .await
        .with_context(|| format!("create {}", tmp_dir.display()))?;
    Ok(tmp_dir)
}

fn unix_timestamp_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

async fn download_installer(url: &str, output: &Path) -> Result<()> {
    let output = output.to_string_lossy().to_string();

    if run_downloader("curl", &["-fsSL", url, "-o", &output]).await? {
        return Ok(());
    }

    if run_downloader("wget", &["-q", "-O", &output, url]).await? {
        return Ok(());
    }

    anyhow::bail!("curl or wget is required to update Anya");
}

async fn run_downloader(program: &str, args: &[&str]) -> Result<bool> {
    let status = match Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .status()
        .await
    {
        Ok(status) => status,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error).with_context(|| format!("run {program}")),
    };

    Ok(status.success())
}
