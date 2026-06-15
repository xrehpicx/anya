//! `anya gog` — connect Google services (Gmail, Calendar, Drive, …) to Anya
//! through the `gog`/`gogcli` binary.
//!
//! This mirrors how OpenClaw stays provider-agnostic: Anya owns no Google OAuth
//! code. `gog` performs the Google OAuth flow and keeps tokens in the OS keyring,
//! and Anya simply registers `gog`'s MCP server in its config so the embedded
//! Codex agent gains typed, read-only Google tools. The bundled `anya-gog` skill
//! (seeded in `home.rs`) teaches the agent how to drive `gog` for writes such as
//! sending mail. Gmail is just the first of the many services `gog` exposes.

use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;

use anyhow::Context;
use anyhow::Result;
use clap::Args;
use clap::Subcommand;
use codex_config::types::McpServerConfig;
use codex_config::types::McpServerTransportConfig;

use crate::home;

/// Name of the MCP server entry Anya writes into `~/.anya/config.toml`.
const GOG_MCP_SERVER_NAME: &str = "gog";
/// Default Google services to authorize when connecting an account.
const DEFAULT_SERVICES: &str = "gmail,calendar,drive,docs,sheets,contacts";

#[derive(Debug, Args)]
pub struct GogArgs {
    #[command(subcommand)]
    command: GogCommand,
}

#[derive(Debug, Subcommand)]
enum GogCommand {
    /// Connect a Google account to Anya: authorize gog, then register its MCP tools.
    Connect(ConnectArgs),
    /// Show gog install state, authorized accounts, and MCP registration.
    Status(StatusArgs),
    /// Register or remove the gog MCP server in Anya's config.toml.
    Mcp(McpArgs),
}

#[derive(Debug, Args)]
struct ConnectArgs {
    /// Google account email to authorize, e.g. you@gmail.com.
    #[arg(long)]
    email: Option<String>,
    /// Path to a Google Cloud Desktop OAuth client_secret_*.json to register with gog first.
    #[arg(long)]
    credentials: Option<PathBuf>,
    /// Comma-separated Google services to authorize.
    #[arg(long, default_value = DEFAULT_SERVICES)]
    services: String,
    /// Use gog's manual (headless / no local browser) OAuth flow.
    #[arg(long)]
    manual: bool,
    /// Do not register the gog MCP server in Anya's config.toml.
    #[arg(long)]
    no_mcp: bool,
    /// Let the MCP server perform Google write actions. Off by default (read-only).
    #[arg(long)]
    allow_write: bool,
    /// Path to the gog binary.
    #[arg(long, default_value = "gog")]
    gog_bin: String,
}

#[derive(Debug, Args)]
struct StatusArgs {
    /// Path to the gog binary.
    #[arg(long, default_value = "gog")]
    gog_bin: String,
}

#[derive(Debug, Args)]
struct McpArgs {
    #[command(subcommand)]
    command: McpCommand,
}

#[derive(Debug, Subcommand)]
enum McpCommand {
    /// Register (or update) the gog MCP server in Anya's config.toml.
    Register(McpRegisterArgs),
    /// Remove the gog MCP server from Anya's config.toml.
    Unregister,
}

#[derive(Debug, Args)]
struct McpRegisterArgs {
    /// Google account email the MCP server should serve, e.g. you@gmail.com.
    #[arg(long)]
    email: String,
    /// Let the MCP server perform Google write actions. Off by default (read-only).
    #[arg(long)]
    allow_write: bool,
    /// Path to the gog binary.
    #[arg(long, default_value = "gog")]
    gog_bin: String,
}

pub async fn run(args: GogArgs) -> Result<()> {
    match args.command {
        GogCommand::Connect(args) => connect(args).await,
        GogCommand::Status(args) => status(args).await,
        GogCommand::Mcp(args) => match args.command {
            McpCommand::Register(args) => {
                let anya_home = home::anya_home_path()?;
                register_gog_mcp_server(&anya_home, &args.email, &args.gog_bin, args.allow_write)
                    .await?;
                println!(
                    "Registered MCP server '{GOG_MCP_SERVER_NAME}' for {} in {}.",
                    args.email,
                    anya_home.join("config.toml").display()
                );
                print_apply_hint();
                Ok(())
            }
            McpCommand::Unregister => {
                let anya_home = home::anya_home_path()?;
                let removed = unregister_gog_mcp_server(&anya_home).await?;
                if removed {
                    println!("Removed MCP server '{GOG_MCP_SERVER_NAME}' from config.toml.");
                    print_apply_hint();
                } else {
                    println!("No MCP server '{GOG_MCP_SERVER_NAME}' was registered.");
                }
                Ok(())
            }
        },
    }
}

async fn connect(args: ConnectArgs) -> Result<()> {
    if !gog_present(&args.gog_bin) {
        print_install_help(&args.gog_bin);
        anyhow::bail!("gog is not installed or not on PATH");
    }

    let email = match args.email {
        Some(email) => email,
        None => prompt_line("Google account email (e.g. you@gmail.com): ")?,
    };
    if email.is_empty() {
        anyhow::bail!("a Google account email is required to connect");
    }

    if let Some(credentials) = args.credentials.as_deref() {
        println!("Registering OAuth client credentials with gog…");
        let credentials = credentials.to_string_lossy();
        run_gog_interactive(
            &args.gog_bin,
            &["auth", "credentials", credentials.as_ref()],
        )?;
    }

    println!("Authorizing {email} for: {}", args.services);
    let mut auth_args = vec![
        "auth",
        "add",
        email.as_str(),
        "--services",
        args.services.as_str(),
    ];
    if args.manual {
        auth_args.push("--manual");
    }
    run_gog_interactive(&args.gog_bin, &auth_args)?;

    if args.no_mcp {
        println!(
            "Skipping MCP registration (--no-mcp). Anya can still use gog from the shell via the anya-gog skill."
        );
    } else {
        let anya_home = home::anya_home_path()?;
        register_gog_mcp_server(&anya_home, &email, &args.gog_bin, args.allow_write).await?;
        let mode = if args.allow_write {
            "read+write"
        } else {
            "read-only"
        };
        println!(
            "Registered {mode} MCP server '{GOG_MCP_SERVER_NAME}' in {}.",
            anya_home.join("config.toml").display()
        );
    }

    println!("Connected Google account {email} to Anya.");
    print_apply_hint();
    Ok(())
}

async fn status(args: StatusArgs) -> Result<()> {
    if gog_present(&args.gog_bin) {
        match gog_version(&args.gog_bin) {
            Some(version) => println!("gog: installed ({})", version.trim()),
            None => println!("gog: installed"),
        }
        println!("\nAuthorized accounts (`{} auth list`):", args.gog_bin);
        // gog prints account state to stdout; surface it verbatim.
        let _ = Command::new(&args.gog_bin).args(["auth", "list"]).status();
    } else {
        println!("gog: not installed or not on PATH");
        print_install_help(&args.gog_bin);
    }

    let anya_home = home::anya_home_path()?;
    let servers = codex_config::load_global_mcp_servers(&anya_home)
        .await
        .with_context(|| format!("load MCP servers from {}", anya_home.display()))?;
    match servers.get(GOG_MCP_SERVER_NAME) {
        Some(_) => println!(
            "\nMCP server '{GOG_MCP_SERVER_NAME}': registered in {}",
            anya_home.join("config.toml").display()
        ),
        None => println!(
            "\nMCP server '{GOG_MCP_SERVER_NAME}': not registered (run `anya gog connect`)"
        ),
    }
    Ok(())
}

/// Inserts/updates the gog MCP server entry, preserving other config.toml content.
async fn register_gog_mcp_server(
    anya_home: &Path,
    email: &str,
    gog_bin: &str,
    allow_write: bool,
) -> Result<()> {
    let mut servers = codex_config::load_global_mcp_servers(anya_home)
        .await
        .with_context(|| format!("load MCP servers from {}", anya_home.display()))?;
    servers.insert(
        GOG_MCP_SERVER_NAME.to_string(),
        gog_mcp_server_config(email, gog_bin, allow_write),
    );
    codex_config::ConfigEditsBuilder::new(anya_home)
        .replace_mcp_servers(&servers)
        .apply()
        .await
        .with_context(|| format!("write MCP servers to {}", anya_home.display()))?;
    Ok(())
}

/// Removes the gog MCP server entry. Returns whether an entry was present.
async fn unregister_gog_mcp_server(anya_home: &Path) -> Result<bool> {
    let mut servers = codex_config::load_global_mcp_servers(anya_home)
        .await
        .with_context(|| format!("load MCP servers from {}", anya_home.display()))?;
    if servers.remove(GOG_MCP_SERVER_NAME).is_none() {
        return Ok(false);
    }
    codex_config::ConfigEditsBuilder::new(anya_home)
        .replace_mcp_servers(&servers)
        .apply()
        .await
        .with_context(|| format!("write MCP servers to {}", anya_home.display()))?;
    Ok(true)
}

/// Builds the stdio MCP server config that launches `gog … mcp` for one account.
fn gog_mcp_server_config(email: &str, gog_bin: &str, allow_write: bool) -> McpServerConfig {
    let mut args = vec![
        "--account".to_string(),
        email.to_string(),
        "mcp".to_string(),
    ];
    if allow_write {
        // gog's MCP server is read-only unless writes are explicitly opted in.
        args.push("--allow-write".to_string());
    }
    McpServerConfig {
        transport: McpServerTransportConfig::Stdio {
            command: gog_bin.to_string(),
            args,
            env: None,
            env_vars: Vec::new(),
            cwd: None,
        },
        environment_id: codex_config::DEFAULT_MCP_SERVER_ENVIRONMENT_ID.to_string(),
        enabled: true,
        required: false,
        supports_parallel_tool_calls: false,
        disabled_reason: None,
        startup_timeout_sec: None,
        tool_timeout_sec: None,
        default_tools_approval_mode: None,
        enabled_tools: None,
        disabled_tools: None,
        scopes: None,
        oauth: None,
        oauth_resource: None,
        tools: HashMap::new(),
    }
}

fn run_gog_interactive(gog_bin: &str, args: &[&str]) -> Result<()> {
    let status = Command::new(gog_bin)
        .args(args)
        .status()
        .with_context(|| format!("run `{gog_bin} {}`", args.join(" ")))?;
    if !status.success() {
        anyhow::bail!("`{gog_bin} {}` failed ({status})", args.join(" "));
    }
    Ok(())
}

/// Returns gog's version string when the binary is runnable, else None.
fn gog_version(gog_bin: &str) -> Option<String> {
    for version_arg in ["version", "--version"] {
        if let Ok(output) = Command::new(gog_bin).arg(version_arg).output()
            && output.status.success()
        {
            return Some(String::from_utf8_lossy(&output.stdout).into_owned());
        }
    }
    None
}

fn gog_present(gog_bin: &str) -> bool {
    match Command::new(gog_bin).arg("--version").output() {
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        // Spawned but errored for another reason — the binary still exists.
        Err(_) => true,
    }
}

fn prompt_line(prompt: &str) -> Result<String> {
    print!("{prompt}");
    std::io::stdout().flush().ok();
    let mut line = String::new();
    std::io::stdin()
        .read_line(&mut line)
        .context("read input from stdin")?;
    Ok(line.trim().to_string())
}

fn print_install_help(gog_bin: &str) {
    eprintln!(
        "gog (gogcli) was not found as `{gog_bin}`.\n\
         Install it, then re-run `anya gog connect`:\n\
         \x20\x20brew install openclaw/tap/gogcli\n\
         \x20\x20# other platforms: https://gogcli.sh/\n\
         If gog is installed elsewhere, pass --gog-bin /path/to/gog."
    );
}

fn print_apply_hint() {
    println!(
        "Run `anya config check` then `anya config apply` (or restart the service) so Anya loads the gog tools."
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    use pretty_assertions::assert_eq;

    use crate::Cli;
    use crate::CommandKind;

    #[test]
    fn gog_mcp_server_config_builds_read_only_stdio() {
        let config = gog_mcp_server_config("you@gmail.com", "gog", /*allow_write*/ false);
        let McpServerTransportConfig::Stdio { command, args, .. } = config.transport else {
            panic!("expected stdio transport");
        };
        assert_eq!("gog", command);
        assert_eq!(
            vec!["--account", "you@gmail.com", "mcp"],
            args.iter().map(String::as_str).collect::<Vec<_>>()
        );
        assert!(config.enabled);
    }

    #[test]
    fn gog_mcp_server_config_opts_into_writes() {
        let config = gog_mcp_server_config("you@gmail.com", "/opt/gog", /*allow_write*/ true);
        let McpServerTransportConfig::Stdio { command, args, .. } = config.transport else {
            panic!("expected stdio transport");
        };
        assert_eq!("/opt/gog", command);
        assert_eq!(Some(&"--allow-write".to_string()), args.last());
    }

    #[tokio::test]
    async fn registers_then_unregisters_gog_mcp_server() {
        // A fresh home has no config.toml; this also covers the first-run path.
        let home = std::env::temp_dir().join(format!("anya-gog-roundtrip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();

        register_gog_mcp_server(&home, "you@gmail.com", "gog", /*allow_write*/ false)
            .await
            .unwrap();
        let servers = codex_config::load_global_mcp_servers(&home).await.unwrap();
        let server = servers
            .get(GOG_MCP_SERVER_NAME)
            .expect("gog server should be registered");
        let McpServerTransportConfig::Stdio { command, .. } = &server.transport else {
            panic!("expected stdio transport");
        };
        assert_eq!("gog", command);

        assert!(unregister_gog_mcp_server(&home).await.unwrap());
        let servers = codex_config::load_global_mcp_servers(&home).await.unwrap();
        assert!(!servers.contains_key(GOG_MCP_SERVER_NAME));

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn parses_gog_connect_command() {
        let cli = Cli::try_parse_from([
            "anya",
            "gog",
            "connect",
            "--email",
            "you@gmail.com",
            "--manual",
        ])
        .unwrap();
        match cli.command {
            CommandKind::Gog(args) => match args.command {
                super::GogCommand::Connect(connect) => {
                    assert_eq!(Some("you@gmail.com".to_string()), connect.email);
                    assert!(connect.manual);
                    assert!(!connect.allow_write);
                    assert_eq!(super::DEFAULT_SERVICES, connect.services);
                }
                other => panic!("unexpected gog command: {other:?}"),
            },
            other => panic!("unexpected command: {other:?}"),
        }
    }

    #[test]
    fn parses_gmail_alias_for_gog() {
        let cli = Cli::try_parse_from(["anya", "gmail", "status"]).unwrap();
        assert!(matches!(cli.command, CommandKind::Gog(_)));
    }
}
