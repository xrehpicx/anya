use std::path::Path;
use std::path::PathBuf;

use anyhow::Result;
use clap::Args;
use clap::Subcommand;
use codex_config::config_toml::ConfigToml;
use serde::Serialize;

use crate::home;
use crate::service;

#[derive(Debug, Args)]
pub struct ConfigArgs {
    #[command(subcommand)]
    command: ConfigCommand,
}

#[derive(Debug, Subcommand)]
enum ConfigCommand {
    /// Print the config files Anya uses.
    Paths(ConfigPathsArgs),
    /// Validate Anya config files without applying them.
    Check(ConfigCheckArgs),
    /// Validate config files, then safely restart the running Anya service.
    Apply(ConfigApplyArgs),
}

#[derive(Debug, Args)]
struct ConfigPathsArgs {
    /// Print machine-readable JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Args)]
struct ConfigCheckArgs {
    /// Print machine-readable JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Args)]
struct ConfigApplyArgs {
    /// User systemd service name to restart after validation.
    #[arg(long, default_value = "anya")]
    service: String,
    /// Print machine-readable JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnyaConfigPaths {
    anya_home: PathBuf,
    config_toml: PathBuf,
    setup_json: PathBuf,
    auth_json: PathBuf,
    whatsapp_config_json: PathBuf,
    whatsapp_message_log_json: PathBuf,
    whatsapp_control_socket: PathBuf,
    skills_dir: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigCheckReport {
    ok: bool,
    paths: AnyaConfigPaths,
    checks: Vec<ConfigCheck>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigCheck {
    name: String,
    path: PathBuf,
    ok: bool,
    required: bool,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigApplyReport {
    ok: bool,
    service: String,
    check: ConfigCheckReport,
    applied: bool,
}

pub async fn run(args: ConfigArgs) -> Result<()> {
    match args.command {
        ConfigCommand::Paths(args) => paths(args),
        ConfigCommand::Check(args) => check(args),
        ConfigCommand::Apply(args) => apply(args).await,
    }
}

fn paths(args: ConfigPathsArgs) -> Result<()> {
    let paths = config_paths()?;
    if args.json {
        serde_json::to_writer_pretty(std::io::stdout(), &paths)?;
        println!();
    } else {
        print_paths(&paths);
    }
    Ok(())
}

fn check(args: ConfigCheckArgs) -> Result<()> {
    let report = check_config()?;
    if args.json {
        serde_json::to_writer_pretty(std::io::stdout(), &report)?;
        println!();
    } else {
        print_check_report(&report);
    }
    if report.ok {
        Ok(())
    } else {
        anyhow::bail!("Anya config check failed");
    }
}

async fn apply(args: ConfigApplyArgs) -> Result<()> {
    let report = check_config()?;
    if !report.ok {
        if args.json {
            let apply_report = ConfigApplyReport {
                ok: false,
                service: args.service,
                check: report,
                applied: false,
            };
            serde_json::to_writer_pretty(std::io::stdout(), &apply_report)?;
            println!();
        } else {
            print_check_report(&report);
        }
        anyhow::bail!("Anya config check failed; not applying");
    }

    service::restart_user_systemd_unit(&args.service).await?;
    let apply_report = ConfigApplyReport {
        ok: true,
        service: args.service,
        check: report,
        applied: true,
    };
    if args.json {
        serde_json::to_writer_pretty(std::io::stdout(), &apply_report)?;
        println!();
    } else {
        print_check_report(&apply_report.check);
        println!("Applied: restarted {}.service", apply_report.service);
    }
    Ok(())
}

fn check_config() -> Result<ConfigCheckReport> {
    let paths = config_paths()?;
    let checks = vec![
        check_config_toml(&paths.config_toml),
        check_setup_json(&paths.setup_json),
        check_optional_json("auth.json", &paths.auth_json),
        check_optional_json("whatsapp config.json", &paths.whatsapp_config_json),
        check_optional_json(
            "whatsapp message-log.json",
            &paths.whatsapp_message_log_json,
        ),
        check_skills_dir(&paths.skills_dir),
    ];
    let ok = checks.iter().all(|check| check.ok || !check.required);
    Ok(ConfigCheckReport { ok, paths, checks })
}

fn config_paths() -> Result<AnyaConfigPaths> {
    let anya_home = home::anya_home_path()?;
    let whatsapp_dir = dirs::data_dir()
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".local")
                .join("share")
        })
        .join("anya")
        .join("whatsapp");
    Ok(AnyaConfigPaths {
        config_toml: anya_home.join("config.toml"),
        setup_json: anya_home.join("setup.json"),
        auth_json: anya_home.join("auth.json"),
        skills_dir: anya_home.join("skills"),
        anya_home,
        whatsapp_config_json: whatsapp_dir.join("config.json"),
        whatsapp_message_log_json: whatsapp_dir.join("message-log.json"),
        whatsapp_control_socket: whatsapp_dir.join("control.sock"),
    })
}

fn check_config_toml(path: &Path) -> ConfigCheck {
    match std::fs::read_to_string(path) {
        Ok(contents) => match toml::from_str::<ConfigToml>(&contents) {
            Ok(_) => ConfigCheck {
                name: "config.toml".to_string(),
                path: path.to_path_buf(),
                ok: true,
                required: false,
                message: "valid Codex/Anya config TOML".to_string(),
            },
            Err(error) => ConfigCheck {
                name: "config.toml".to_string(),
                path: path.to_path_buf(),
                ok: false,
                required: true,
                message: error.to_string(),
            },
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => ConfigCheck {
            name: "config.toml".to_string(),
            path: path.to_path_buf(),
            ok: true,
            required: false,
            message: "not present; defaults will be used".to_string(),
        },
        Err(error) => ConfigCheck {
            name: "config.toml".to_string(),
            path: path.to_path_buf(),
            ok: false,
            required: true,
            message: error.to_string(),
        },
    }
}

fn check_setup_json(path: &Path) -> ConfigCheck {
    check_json_file("setup.json", path, /*required*/ false)
}

fn check_optional_json(name: &str, path: &Path) -> ConfigCheck {
    check_json_file(name, path, /*required*/ false)
}

fn check_json_file(name: &str, path: &Path, required: bool) -> ConfigCheck {
    match std::fs::read_to_string(path) {
        Ok(contents) => match serde_json::from_str::<serde_json::Value>(&contents) {
            Ok(_) => ConfigCheck {
                name: name.to_string(),
                path: path.to_path_buf(),
                ok: true,
                required,
                message: "valid JSON".to_string(),
            },
            Err(error) => ConfigCheck {
                name: name.to_string(),
                path: path.to_path_buf(),
                ok: false,
                required: true,
                message: error.to_string(),
            },
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => ConfigCheck {
            name: name.to_string(),
            path: path.to_path_buf(),
            ok: true,
            required,
            message: "not present".to_string(),
        },
        Err(error) => ConfigCheck {
            name: name.to_string(),
            path: path.to_path_buf(),
            ok: false,
            required: true,
            message: error.to_string(),
        },
    }
}

fn check_skills_dir(path: &Path) -> ConfigCheck {
    if path.is_dir() {
        ConfigCheck {
            name: "skills directory".to_string(),
            path: path.to_path_buf(),
            ok: true,
            required: false,
            message: "present".to_string(),
        }
    } else {
        ConfigCheck {
            name: "skills directory".to_string(),
            path: path.to_path_buf(),
            ok: true,
            required: false,
            message: "not present; Anya will seed bundled skills on startup".to_string(),
        }
    }
}

fn print_paths(paths: &AnyaConfigPaths) {
    println!("Anya home: {}", paths.anya_home.display());
    println!("Config: {}", paths.config_toml.display());
    println!("Setup: {}", paths.setup_json.display());
    println!("Auth: {}", paths.auth_json.display());
    println!("Skills: {}", paths.skills_dir.display());
    println!("WhatsApp config: {}", paths.whatsapp_config_json.display());
    println!(
        "WhatsApp message log: {}",
        paths.whatsapp_message_log_json.display()
    );
    println!(
        "WhatsApp control socket: {}",
        paths.whatsapp_control_socket.display()
    );
}

fn print_check_report(report: &ConfigCheckReport) {
    println!("Anya config: {}", if report.ok { "ok" } else { "failed" });
    for check in &report.checks {
        let state = if check.ok { "ok" } else { "failed" };
        println!(
            "- {state}: {} ({}) - {}",
            check.name,
            check.path.display(),
            check.message
        );
    }
}

#[cfg(test)]
mod tests {
    use clap::Parser;
    use pretty_assertions::assert_eq;

    use crate::Cli;
    use crate::CommandKind;

    #[test]
    fn parses_config_paths_command() {
        let cli = Cli::try_parse_from(["anya", "config", "paths", "--json"]).unwrap();
        match cli.command {
            CommandKind::Config(args) => match args.command {
                super::ConfigCommand::Paths(args) => assert!(args.json),
                other => panic!("unexpected config command: {other:?}"),
            },
            other => panic!("unexpected command: {other:?}"),
        }
    }

    #[test]
    fn parses_config_apply_command() {
        let cli =
            Cli::try_parse_from(["anya", "config", "apply", "--service", "anya-dev", "--json"])
                .unwrap();
        match cli.command {
            CommandKind::Config(args) => match args.command {
                super::ConfigCommand::Apply(args) => {
                    assert_eq!("anya-dev", args.service);
                    assert!(args.json);
                }
                other => panic!("unexpected config command: {other:?}"),
            },
            other => panic!("unexpected command: {other:?}"),
        }
    }
}
