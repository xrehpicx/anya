use std::path::PathBuf;

use anyhow::Context;
use anyhow::Result;
use clap::Args;
use clap::Subcommand;
use serde::Deserialize;
use serde::Serialize;

use crate::home;

#[derive(Debug, Args)]
pub struct SetupArgs {
    #[command(subcommand)]
    command: SetupCommand,
}

#[derive(Debug, Subcommand)]
enum SetupCommand {
    /// Show whether Anya's first-run setup has been explicitly confirmed.
    Status(SetupStatusArgs),
    /// Persist Anya's first-run setup choices.
    Set(SetupSetArgs),
}

#[derive(Debug, Args)]
struct SetupStatusArgs {
    /// Print machine-readable JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Args)]
struct SetupSetArgs {
    /// Directory where Anya should do default project work.
    #[arg(long)]
    default_workdir: PathBuf,
    /// File Anya should read before changing Anya itself.
    #[arg(long)]
    self_iteration_file: PathBuf,
    /// Mark setup as explicitly confirmed by the user.
    #[arg(long)]
    confirm: bool,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupConfig {
    default_workdir: Option<PathBuf>,
    self_iteration_file: Option<PathBuf>,
    confirmed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupStatus {
    complete: bool,
    confirmed: bool,
    setup_file: PathBuf,
    default_workdir: Option<PathBuf>,
    self_iteration_file: Option<PathBuf>,
    inferred_default_workdir: Option<PathBuf>,
    inferred_self_iteration_file: Option<PathBuf>,
    auth_configured: bool,
    whatsapp_configured: bool,
    missing: Vec<String>,
    next_command: Option<String>,
}

pub async fn run(args: SetupArgs) -> Result<()> {
    match args.command {
        SetupCommand::Status(args) => status(args),
        SetupCommand::Set(args) => set(args),
    }
}

fn status(args: SetupStatusArgs) -> Result<()> {
    let status = load_status()?;
    if args.json {
        serde_json::to_writer_pretty(std::io::stdout(), &status)?;
        println!();
    } else {
        print_status(&status);
    }
    Ok(())
}

fn set(args: SetupSetArgs) -> Result<()> {
    let setup_file = setup_file()?;
    let config = SetupConfig {
        default_workdir: Some(expand_home(args.default_workdir)),
        self_iteration_file: Some(expand_home(args.self_iteration_file)),
        confirmed: args.confirm,
    };
    if let Some(parent) = setup_file.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    serde_json::to_writer_pretty(
        std::fs::File::create(&setup_file)
            .with_context(|| format!("create {}", setup_file.display()))?,
        &config,
    )
    .with_context(|| format!("write {}", setup_file.display()))?;
    println!("Wrote {}", setup_file.display());
    print_status(&load_status()?);
    Ok(())
}

fn load_status() -> Result<SetupStatus> {
    let setup_file = setup_file()?;
    let config = if setup_file.exists() {
        serde_json::from_reader::<_, SetupConfig>(
            std::fs::File::open(&setup_file)
                .with_context(|| format!("open {}", setup_file.display()))?,
        )
        .with_context(|| format!("parse {}", setup_file.display()))?
    } else {
        SetupConfig::default()
    };

    let inferred_default_workdir = conventional_default_workdir();
    let inferred_self_iteration_file = conventional_self_iteration_file();
    let default_workdir = config.default_workdir.clone();
    let self_iteration_file = config.self_iteration_file.clone();
    let auth_configured = home::anya_home_path()?.join("auth.json").is_file();
    let whatsapp_configured = whatsapp_config_file().is_file();

    let mut missing = Vec::new();
    if !config.confirmed {
        missing.push("setup_confirmation".to_string());
    }
    if default_workdir.is_none() {
        missing.push("default_workdir".to_string());
    }
    if self_iteration_file.is_none() {
        missing.push("self_iteration_file".to_string());
    }

    let complete = missing.is_empty();
    let next_command = if complete {
        None
    } else {
        let default_workdir = default_workdir
            .as_ref()
            .or(inferred_default_workdir.as_ref())
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "~/anya/projects".to_string());
        let self_iteration_file = self_iteration_file
            .as_ref()
            .or(inferred_self_iteration_file.as_ref())
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "~/anya/ANYA_SELF_ITERATION.md".to_string());
        Some(format!(
            "anya setup set --default-workdir {default_workdir:?} --self-iteration-file {self_iteration_file:?} --confirm"
        ))
    };

    Ok(SetupStatus {
        complete,
        confirmed: config.confirmed,
        setup_file,
        default_workdir,
        self_iteration_file,
        inferred_default_workdir,
        inferred_self_iteration_file,
        auth_configured,
        whatsapp_configured,
        missing,
        next_command,
    })
}

fn print_status(status: &SetupStatus) {
    let state = if status.complete {
        "complete"
    } else {
        "incomplete"
    };
    println!("Anya setup: {state}");
    println!("Setup file: {}", status.setup_file.display());
    if let Some(path) = &status.default_workdir {
        println!("Default workdir: {}", path.display());
    } else if let Some(path) = &status.inferred_default_workdir {
        println!("Inferred default workdir: {}", path.display());
    }
    if let Some(path) = &status.self_iteration_file {
        println!("Self-iteration file: {}", path.display());
    } else if let Some(path) = &status.inferred_self_iteration_file {
        println!("Inferred self-iteration file: {}", path.display());
    }
    println!("Auth configured: {}", yes_no(status.auth_configured));
    println!(
        "WhatsApp configured: {}",
        yes_no(status.whatsapp_configured)
    );
    if !status.missing.is_empty() {
        println!("Missing: {}", status.missing.join(", "));
    }
    if let Some(command) = &status.next_command {
        println!("Next command: {command}");
    }
}

fn setup_file() -> Result<PathBuf> {
    Ok(home::anya_home_path()?.join("setup.json"))
}

fn conventional_default_workdir() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let path = home.join("anya").join("projects");
    path.is_dir().then_some(path)
}

fn conventional_self_iteration_file() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let path = home.join("anya").join("ANYA_SELF_ITERATION.md");
    path.is_file().then_some(path)
}

fn whatsapp_config_file() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".local")
                .join("share")
        })
        .join("anya")
        .join("whatsapp")
        .join("config.json")
}

fn expand_home(path: PathBuf) -> PathBuf {
    let path_string = path.to_string_lossy();
    if let Some(rest) = path_string.strip_prefix("~/")
        && let Some(home) = dirs::home_dir()
    {
        return home.join(rest);
    }
    path
}

fn yes_no(value: bool) -> &'static str {
    if value { "yes" } else { "no" }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use clap::Parser;
    use pretty_assertions::assert_eq;

    use crate::Cli;
    use crate::CommandKind;

    #[test]
    fn parses_setup_status_command() {
        let cli = Cli::try_parse_from(["anya", "setup", "status", "--json"]).unwrap();
        match cli.command {
            CommandKind::Setup(args) => match args.command {
                super::SetupCommand::Status(args) => assert!(args.json),
                other => panic!("unexpected setup command: {other:?}"),
            },
            other => panic!("unexpected command: {other:?}"),
        }
    }

    #[test]
    fn parses_setup_set_command() {
        let cli = Cli::try_parse_from([
            "anya",
            "setup",
            "set",
            "--default-workdir",
            "~/anya/projects",
            "--self-iteration-file",
            "~/anya/ANYA_SELF_ITERATION.md",
            "--confirm",
        ])
        .unwrap();
        match cli.command {
            CommandKind::Setup(args) => match args.command {
                super::SetupCommand::Set(args) => {
                    assert_eq!(PathBuf::from("~/anya/projects"), args.default_workdir);
                    assert_eq!(
                        PathBuf::from("~/anya/ANYA_SELF_ITERATION.md"),
                        args.self_iteration_file
                    );
                    assert!(args.confirm);
                }
                other => panic!("unexpected setup command: {other:?}"),
            },
            other => panic!("unexpected command: {other:?}"),
        }
    }
}
