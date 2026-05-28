mod channel;
mod codex_rpc;
mod service;
mod whatsapp;

use std::io::BufRead;
use std::io::Write;
use std::path::PathBuf;

use anyhow::Context;
use anyhow::Result;
use clap::Args;
use clap::Parser;
use clap::Subcommand;
use codex_arg0::Arg0DispatchPaths;
use codex_arg0::arg0_dispatch_or_else;
use codex_cli::read_access_token_from_stdin;
use codex_cli::read_api_key_from_stdin;
use codex_cli::run_login_status;
use codex_cli::run_login_with_access_token;
use codex_cli::run_login_with_api_key;
use codex_cli::run_login_with_chatgpt;
use codex_cli::run_login_with_device_code;
use codex_cli::run_logout;
use codex_config::LoaderOverrides;
use codex_protocol::protocol::SessionSource;
use codex_tui::AppExitInfo;
use codex_tui::Cli as CodexTuiCli;
use codex_tui::ExitReason;
use codex_utils_cli::CliConfigOverrides;
use codex_utils_cli::resume_hint;
use supports_color::Stream;

use crate::channel::ChannelStore;
use crate::codex_rpc::CodexRpcClient;

#[derive(Debug, Parser)]
#[command(
    name = "anya",
    version,
    about = "Minimal service wrapper for a Codex-compatible agent"
)]
struct Cli {
    #[command(subcommand)]
    command: CommandKind,
}

#[derive(Debug, Subcommand)]
enum CommandKind {
    /// Run the Codex app-server in the foreground under the Anya service name.
    Serve(ServeArgs),
    /// Manage login for the embedded Codex agent.
    Login(LoginArgs),
    /// Remove stored authentication credentials for the embedded Codex agent.
    Logout(LogoutArgs),
    /// Install or print a systemd unit for Anya.
    Service(ServiceArgs),
    /// Install and run the WhatsApp bridge channel.
    Whatsapp(whatsapp::WhatsappArgs),
    /// Create, list, and bind generalized chat channels to Codex threads.
    #[command(alias = "channels")]
    Channel(ChannelArgs),
    /// Create a Codex thread through the running app server.
    SessionCreate(SessionCreateArgs),
    /// Send a message to an existing session/thread.
    SessionSend(SessionSendArgs),
    /// Open an interactive CLI chat bound to a channel.
    Chat(ChatArgs),
    /// Open the Codex TUI for the main Anya session.
    Tui(TuiArgs),
    /// Send a raw JSON-RPC request to the running app server.
    Rpc(RpcArgs),
}

#[derive(Debug, Args)]
struct ServeArgs {
    /// App-server listen URL, e.g. ws://127.0.0.1:4827, unix:///run/anya.sock, or stdio://.
    #[arg(long, env = "ANYA_LISTEN", default_value = "ws://127.0.0.1:4827")]
    listen: String,

    /// Session source passed through to Codex.
    #[arg(long, default_value = "vscode")]
    session_source: String,
}

#[derive(Debug, Args)]
struct LoginArgs {
    #[clap(flatten)]
    config_overrides: CliConfigOverrides,

    #[arg(long = "with-api-key")]
    with_api_key: bool,

    #[arg(long = "with-access-token")]
    with_access_token: bool,

    #[arg(long = "device-auth")]
    use_device_code: bool,

    /// EXPERIMENTAL: Use custom OAuth issuer base URL.
    #[arg(long = "experimental_issuer", value_name = "URL", hide = true)]
    issuer_base_url: Option<String>,

    /// EXPERIMENTAL: Use custom OAuth client ID.
    #[arg(long = "experimental_client-id", value_name = "CLIENT_ID", hide = true)]
    client_id: Option<String>,

    #[command(subcommand)]
    action: Option<LoginSubcommand>,
}

#[derive(Debug, Subcommand)]
enum LoginSubcommand {
    /// Show login status.
    Status,
}

#[derive(Debug, Args)]
struct LogoutArgs {
    #[clap(flatten)]
    config_overrides: CliConfigOverrides,
}

#[derive(Debug, Args)]
struct ServiceArgs {
    #[command(subcommand)]
    command: ServiceCommand,
}

#[derive(Debug, Subcommand)]
enum ServiceCommand {
    /// Print a systemd unit to stdout.
    Print(ServiceUnitArgs),
    /// Install a systemd unit. Requires permission to write the selected unit path.
    Install(ServiceUnitArgs),
}

#[derive(Debug, Args, Clone)]
struct ServiceUnitArgs {
    #[arg(long, default_value = "anya")]
    name: String,
    #[arg(long, default_value = "/usr/local/bin/anya")]
    binary: PathBuf,
    #[arg(long, default_value = "ws://127.0.0.1:4827")]
    listen: String,
    #[arg(long, default_value = "/etc/systemd/system")]
    systemd_dir: PathBuf,
    #[arg(long)]
    user: Option<String>,
    #[arg(long)]
    working_directory: Option<PathBuf>,
}

#[derive(Debug, Args)]
struct ChannelArgs {
    #[command(subcommand)]
    command: ChannelCommand,
}

#[derive(Debug, Subcommand)]
enum ChannelCommand {
    List,
    Bind {
        name: String,
        thread_id: String,
    },
    Resolve {
        name: String,
    },
    /// Configure a WhatsApp-backed channel bridge.
    Whatsapp(whatsapp::WhatsappArgs),
}

#[derive(Debug, Args)]
struct SessionCreateArgs {
    #[arg(long, env = "ANYA_ENDPOINT", default_value = "ws://127.0.0.1:4827")]
    endpoint: String,
    #[arg(long)]
    model: Option<String>,
    #[arg(long)]
    cwd: Option<String>,
    #[arg(long)]
    channel: Option<String>,
}

#[derive(Debug, Args)]
struct SessionSendArgs {
    #[arg(long, env = "ANYA_ENDPOINT", default_value = "ws://127.0.0.1:4827")]
    endpoint: String,
    #[arg(long)]
    thread_id: Option<String>,
    #[arg(long)]
    channel: Option<String>,
    #[arg(long)]
    wait: bool,
    #[arg(required = true, trailing_var_arg = true)]
    message: Vec<String>,
}

#[derive(Debug, Args)]
struct ChatArgs {
    #[arg(long, env = "ANYA_ENDPOINT", default_value = "ws://127.0.0.1:4827")]
    endpoint: String,
    #[arg(long, default_value = "main")]
    channel: String,
    #[arg(long)]
    model: Option<String>,
    #[arg(long)]
    cwd: Option<String>,
}

#[derive(Debug, Args)]
struct TuiArgs {
    #[arg(long, default_value = "main")]
    channel: String,
}

#[derive(Debug, Args)]
struct RpcArgs {
    #[arg(long, env = "ANYA_ENDPOINT", default_value = "ws://127.0.0.1:4827")]
    endpoint: String,
    method: String,
    #[arg(long, default_value = "{}")]
    params: String,
}

fn main() -> Result<()> {
    arg0_dispatch_or_else(|arg0_paths| async move { run(arg0_paths).await })
}

async fn run(arg0_paths: Arg0DispatchPaths) -> Result<()> {
    match Cli::parse().command {
        CommandKind::Serve(args) => serve(args, arg0_paths).await,
        CommandKind::Login(args) => login(args).await,
        CommandKind::Logout(args) => logout(args).await,
        CommandKind::Service(args) => service(args).await,
        CommandKind::Whatsapp(args) => whatsapp::run(args).await,
        CommandKind::Channel(args) => channel(args).await,
        CommandKind::SessionCreate(args) => session_create(args).await,
        CommandKind::SessionSend(args) => session_send(args).await,
        CommandKind::Chat(args) => chat(args).await,
        CommandKind::Tui(args) => tui(args, arg0_paths).await,
        CommandKind::Rpc(args) => rpc(args).await,
    }
}

async fn login(args: LoginArgs) -> Result<()> {
    match args.action {
        Some(LoginSubcommand::Status) => run_login_status(args.config_overrides).await,
        None => {
            if args.with_api_key && args.with_access_token {
                anyhow::bail!(
                    "choose one login credential source: --with-api-key or --with-access-token"
                );
            }
            if args.use_device_code {
                run_login_with_device_code(
                    args.config_overrides,
                    args.issuer_base_url,
                    args.client_id,
                )
                .await;
            }
            if args.with_api_key {
                let api_key = read_api_key_from_stdin();
                run_login_with_api_key(args.config_overrides, api_key).await;
            }
            if args.with_access_token {
                let access_token = read_access_token_from_stdin();
                run_login_with_access_token(args.config_overrides, access_token).await;
            }
            run_login_with_chatgpt(args.config_overrides).await;
        }
    }
}

async fn logout(args: LogoutArgs) -> Result<()> {
    run_logout(args.config_overrides).await;
}

async fn serve(args: ServeArgs, arg0_paths: Arg0DispatchPaths) -> Result<()> {
    let transport = codex_app_server::AppServerTransport::from_listen_url(&args.listen)
        .map_err(|err| anyhow::anyhow!(err))?;
    let session_source = SessionSource::from_startup_arg(&args.session_source)
        .map_err(|err| anyhow::anyhow!(err))?;
    codex_app_server::run_main_with_transport_options(
        arg0_paths,
        CliConfigOverrides::default(),
        LoaderOverrides::default(),
        /*strict_config*/ false,
        /*default_analytics_enabled*/ false,
        transport,
        session_source,
        codex_app_server::AppServerWebsocketAuthSettings::default(),
        codex_app_server::AppServerRuntimeOptions::default(),
    )
    .await
    .context("run embedded Codex app-server")
}

async fn service(args: ServiceArgs) -> Result<()> {
    match args.command {
        ServiceCommand::Print(unit_args) => {
            print!("{}", service::systemd_unit(&unit_args));
            Ok(())
        }
        ServiceCommand::Install(unit_args) => service::install_systemd_unit(&unit_args).await,
    }
}

async fn channel(args: ChannelArgs) -> Result<()> {
    match args.command {
        ChannelCommand::List => {
            let store = ChannelStore::load().await?;
            serde_json::to_writer_pretty(std::io::stdout(), store.channels())?;
            println!();
        }
        ChannelCommand::Bind { name, thread_id } => {
            let mut store = ChannelStore::load().await?;
            store.bind(name, thread_id);
            store.save().await?;
        }
        ChannelCommand::Resolve { name } => {
            let store = ChannelStore::load().await?;
            let thread_id = store
                .resolve(&name)
                .with_context(|| format!("unknown channel {name:?}"))?;
            println!("{thread_id}");
        }
        ChannelCommand::Whatsapp(args) => whatsapp::run(args).await?,
    }
    Ok(())
}

async fn session_create(args: SessionCreateArgs) -> Result<()> {
    let mut client = CodexRpcClient::connect(&args.endpoint).await?;
    let response = client.thread_start(args.model, args.cwd).await?;
    if let Some(channel) = args.channel {
        let mut store = ChannelStore::load().await?;
        store.bind(channel, response.thread.id.clone());
        store.save().await?;
    }
    serde_json::to_writer_pretty(std::io::stdout(), &response)?;
    println!();
    Ok(())
}

async fn session_send(args: SessionSendArgs) -> Result<()> {
    let thread_id = match (args.thread_id, args.channel) {
        (Some(thread_id), None) => thread_id,
        (None, Some(channel)) => ChannelStore::load()
            .await?
            .resolve(&channel)
            .with_context(|| format!("unknown channel {channel:?}"))?
            .to_string(),
        (Some(_), Some(_)) => anyhow::bail!("pass either --thread-id or --channel, not both"),
        (None, None) => anyhow::bail!("pass --thread-id or --channel"),
    };
    let message = args.message.join(" ");
    let mut client = CodexRpcClient::connect(&args.endpoint).await?;
    if args.wait {
        let response = client.turn_start_collect(thread_id, message).await?;
        println!("{response}");
    } else {
        let response = client.turn_start(thread_id, message).await?;
        serde_json::to_writer_pretty(std::io::stdout(), &response)?;
        println!();
    }
    Ok(())
}

async fn chat(args: ChatArgs) -> Result<()> {
    let mut store = ChannelStore::load().await?;
    let mut client = CodexRpcClient::connect(&args.endpoint).await?;
    let thread_id = match store.resolve(&args.channel) {
        Some(thread_id) => thread_id.to_string(),
        None => {
            let response = client.thread_start(args.model, args.cwd).await?;
            let thread_id = response.thread.id;
            store.bind(args.channel.clone(), thread_id.clone());
            store.save().await?;
            thread_id
        }
    };

    let stdin = std::io::stdin();
    let mut stdin = stdin.lock();
    let mut line = String::new();
    loop {
        print!("you> ");
        std::io::stdout().flush()?;
        line.clear();
        if stdin.read_line(&mut line)? == 0 {
            break;
        }
        let message = line.trim();
        if message.is_empty() {
            continue;
        }
        if matches!(message, "/exit" | "/quit") {
            break;
        }
        print!("anya> ");
        std::io::stdout().flush()?;
        client
            .turn_start_streaming(thread_id.clone(), message.to_string())
            .await?;
    }
    Ok(())
}

async fn tui(args: TuiArgs, arg0_paths: Arg0DispatchPaths) -> Result<()> {
    let mut tui_cli = CodexTuiCli::parse_from(["anya-tui"]);
    if let Some(thread_id) = ChannelStore::load().await?.resolve(&args.channel) {
        tui_cli.resume_session_id = Some(thread_id.to_string());
    }

    let exit_info = codex_tui::run_main(
        tui_cli,
        arg0_paths,
        LoaderOverrides::default(),
        /*explicit_remote_endpoint*/ None,
    )
    .await
    .context("run embedded Codex TUI")?;

    if let Some(thread_id) = exit_info.thread_id {
        let mut store = ChannelStore::load().await?;
        store.bind(args.channel, thread_id.to_string());
        store.save().await?;
    }

    handle_tui_exit(exit_info)
}

fn handle_tui_exit(exit_info: AppExitInfo) -> Result<()> {
    match &exit_info.exit_reason {
        ExitReason::Fatal(message) => {
            anyhow::bail!(message.clone());
        }
        ExitReason::UserRequested => {}
    }

    let color_enabled = supports_color::on(Stream::Stdout).is_some();
    for line in format_tui_exit_messages(exit_info, color_enabled) {
        println!("{line}");
    }
    Ok(())
}

fn format_tui_exit_messages(exit_info: AppExitInfo, color_enabled: bool) -> Vec<String> {
    let AppExitInfo {
        token_usage,
        thread_id,
        thread_name,
        ..
    } = exit_info;

    let mut lines = Vec::new();
    if !token_usage.is_zero() {
        lines.push(token_usage.to_string());
    }
    if let Some(resume_cmd) = resume_hint(thread_name.as_deref(), thread_id) {
        let command = if color_enabled {
            "\u{1b}[36manya tui\u{1b}[39m".to_string()
        } else {
            "anya tui".to_string()
        };
        lines.push(format!(
            "To continue this Anya session, run {command} ({resume_cmd})"
        ));
    }
    lines
}

async fn rpc(args: RpcArgs) -> Result<()> {
    let mut client = CodexRpcClient::connect(&args.endpoint).await?;
    let params = serde_json::from_str(&args.params).context("parse --params as JSON")?;
    let response = client.request(&args.method, params).await?;
    serde_json::to_writer_pretty(std::io::stdout(), &response)?;
    println!();
    Ok(())
}
