mod channel;
mod codex_rpc;
mod home;
mod service;
mod whatsapp;

use std::io::BufRead;
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

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
use codex_protocol::openai_models::ReasoningEffort;
use codex_protocol::protocol::SessionSource;
use codex_tui::AppExitInfo;
use codex_tui::Cli as CodexTuiCli;
use codex_tui::ExitReason;
use codex_utils_cli::ApprovalModeCliArg;
use codex_utils_cli::CliConfigOverrides;
use codex_utils_cli::SandboxModeCliArg;
use codex_utils_cli::resume_hint;
use supports_color::Stream;

use crate::channel::ChannelStore;
use crate::codex_rpc::CodexRpcClient;

const CHANNEL_SLASH_HELP: &str = "Anya commands: /new, /reset, /stop, /status, /help.";

fn parse_reasoning_effort(value: &str) -> std::result::Result<ReasoningEffort, String> {
    value.parse()
}

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
    /// Check whether the embedded Codex agent can authenticate successfully.
    Auth(AuthArgs),
    /// Remove stored authentication credentials for the embedded Codex agent.
    Logout(LogoutArgs),
    /// Install or print a systemd unit for Anya.
    Service(ServiceArgs),
    /// Install and run the WhatsApp bridge channel.
    Whatsapp(Box<whatsapp::WhatsappArgs>),
    /// Create, list, and bind generalized chat channels to Codex threads.
    #[command(alias = "channels")]
    Channel(ChannelArgs),
    /// Create a Codex thread through the running app server.
    SessionCreate(SessionCreateArgs),
    /// Send a message to an existing session/thread.
    SessionSend(SessionSendArgs),
    /// Steer an active turn in an existing session/thread.
    SessionSteer(SessionSteerArgs),
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

    /// Do not start configured channel bridges from the Anya gateway service.
    #[arg(long)]
    no_channels: bool,
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
struct AuthArgs {
    #[command(subcommand)]
    command: AuthCommand,
}

#[derive(Debug, Subcommand)]
enum AuthCommand {
    /// Probe the running Anya gateway with a tiny Codex turn.
    Status(AuthStatusArgs),
}

#[derive(Debug, Args)]
struct AuthStatusArgs {
    #[arg(long, env = "ANYA_ENDPOINT", default_value = "ws://127.0.0.1:4827")]
    endpoint: String,
    #[arg(long, default_value_t = 45)]
    timeout_secs: u64,
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
    /// Safely restart the user systemd service from outside the Anya cgroup.
    Restart(ServiceRestartArgs),
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
struct ServiceRestartArgs {
    #[arg(long, default_value = "anya")]
    name: String,
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
    Whatsapp(Box<whatsapp::WhatsappArgs>),
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
    /// Stream JSON-lines turn events to stdout as the app-server emits them.
    #[arg(long, conflicts_with = "wait")]
    stream_json: bool,
    /// Attach one or more local image files to this turn.
    #[arg(long = "image", value_name = "PATH")]
    images: Vec<PathBuf>,
    /// Override the model for this turn and subsequent turns in the session.
    #[arg(long)]
    model: Option<String>,
    /// Override reasoning effort for this turn and subsequent turns.
    #[arg(long, value_parser = parse_reasoning_effort)]
    effort: Option<ReasoningEffort>,
    #[arg(required = true, trailing_var_arg = true)]
    message: Vec<String>,
}

#[derive(Debug, Args)]
struct SessionSteerArgs {
    #[arg(long, env = "ANYA_ENDPOINT", default_value = "ws://127.0.0.1:4827")]
    endpoint: String,
    #[arg(long)]
    thread_id: Option<String>,
    #[arg(long)]
    channel: Option<String>,
    #[arg(long)]
    turn_id: String,
    /// Attach one or more local image files to this steering input.
    #[arg(long = "image", value_name = "PATH")]
    images: Vec<PathBuf>,
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

#[derive(Debug, Clone, PartialEq, Eq)]
enum ChannelSlashCommand {
    New { rest: String },
    Reset { rest: String },
    Stop,
    Status,
    Help,
}

fn main() -> Result<()> {
    home::ensure_anya_home()?;
    arg0_dispatch_or_else(|arg0_paths| async move { run(arg0_paths).await })
}

async fn run(arg0_paths: Arg0DispatchPaths) -> Result<()> {
    match Cli::parse().command {
        CommandKind::Serve(args) => serve(args, arg0_paths).await,
        CommandKind::Login(args) => login(args).await,
        CommandKind::Auth(args) => auth(args).await,
        CommandKind::Logout(args) => logout(args).await,
        CommandKind::Service(args) => service(args).await,
        CommandKind::Whatsapp(args) => whatsapp::run(*args).await,
        CommandKind::Channel(args) => channel(args).await,
        CommandKind::SessionCreate(args) => session_create(args).await,
        CommandKind::SessionSend(args) => session_send(args).await,
        CommandKind::SessionSteer(args) => session_steer(args).await,
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

async fn auth(args: AuthArgs) -> Result<()> {
    match args.command {
        AuthCommand::Status(args) => auth_status(args).await,
    }
}

async fn auth_status(args: AuthStatusArgs) -> Result<()> {
    let timeout_secs = args.timeout_secs.max(1);
    let timeout_duration = Duration::from_secs(timeout_secs);
    let mut client = CodexRpcClient::connect(&args.endpoint).await?;
    println!("Gateway: connected ({})", args.endpoint);

    let response = client.thread_start(/*model*/ None, /*cwd*/ None).await?;
    let thread_id = response.thread.id;
    println!("Probe thread: {thread_id}");
    let probe = "Reply exactly: auth-ok".to_string();
    let result = tokio::time::timeout(
        timeout_duration,
        client.turn_start_collect(thread_id, probe, Vec::new(), None, None),
    )
    .await;
    match result {
        Ok(Ok(reply)) if reply.to_ascii_lowercase().contains("auth-ok") => {
            println!("Auth probe: ok");
            Ok(())
        }
        Ok(Ok(reply)) => {
            println!("Auth probe: completed");
            println!("Unexpected reply: {}", reply.trim());
            Ok(())
        }
        Ok(Err(error)) => {
            print_auth_failure_hint(&error);
            Err(error).context("auth probe failed")
        }
        Err(_) => {
            anyhow::bail!(
                "auth probe timed out after {timeout_secs}s. Stored credentials may be stale or the provider may be unavailable. Run `anya login --device-auth`, then restart the anya service."
            );
        }
    }
}

fn print_auth_failure_hint(error: &anyhow::Error) {
    let message = error.to_string();
    if message.contains("token_invalidated")
        || message.contains("refresh_token")
        || message.contains("401 Unauthorized")
        || message.contains("Unauthorized")
    {
        eprintln!(
            "Auth probe: failed because Codex credentials are stale. Run `anya login --device-auth`, then restart the anya service."
        );
    }
}

async fn serve(args: ServeArgs, arg0_paths: Arg0DispatchPaths) -> Result<()> {
    let transport = codex_app_server::AppServerTransport::from_listen_url(&args.listen)
        .map_err(|err| anyhow::anyhow!(err))?;
    let session_source = SessionSource::from_startup_arg(&args.session_source)
        .map_err(|err| anyhow::anyhow!(err))?;
    let _whatsapp_bridge = if args.no_channels {
        None
    } else {
        whatsapp::spawn_gateway_bridge(&args.listen).await?
    };
    codex_app_server::run_main_with_transport_options(
        arg0_paths,
        anya_full_access_config_overrides(),
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
        ServiceCommand::Restart(restart_args) => {
            service::restart_user_systemd_unit(&restart_args.name).await
        }
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
        ChannelCommand::Whatsapp(args) => whatsapp::run(*args).await?,
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
    let message = args.message.join(" ");
    let images = args.images.clone();
    let model = args.model.clone();
    let effort = args.effort;
    if let (Some(channel), Some(command)) =
        (args.channel.clone(), parse_channel_slash_command(&message))
    {
        return session_send_slash_command(&args.endpoint, channel, command, args.wait).await;
    }

    let channel = args.channel.clone();
    let mut thread_id = match (args.thread_id, args.channel) {
        (Some(thread_id), None) => thread_id,
        (None, Some(channel)) => ChannelStore::load()
            .await?
            .resolve(&channel)
            .with_context(|| format!("unknown channel {channel:?}"))?
            .to_string(),
        (Some(_), Some(_)) => anyhow::bail!("pass either --thread-id or --channel, not both"),
        (None, None) => anyhow::bail!("pass --thread-id or --channel"),
    };
    let mut client = CodexRpcClient::connect(&args.endpoint).await?;
    match client.thread_resume(thread_id.clone()).await {
        Ok(_) => {}
        Err(error) if channel.is_some() && is_thread_unavailable_error(&error) => {
            let channel = channel
                .as_deref()
                .context("channel is required for stale thread recovery")?;
            thread_id = create_default_channel_thread(&mut client, channel).await?;
        }
        Err(error) => return Err(error),
    }
    if args.stream_json {
        match client
            .turn_start_json_stream(
                thread_id.clone(),
                message.clone(),
                images.clone(),
                model.clone(),
                effort,
            )
            .await
        {
            Ok(()) => {}
            Err(error) if channel.is_some() && is_thread_not_found_error(&error) => {
                let channel = channel
                    .as_deref()
                    .context("channel is required for stale thread recovery")?;
                let thread_id = create_default_channel_thread(&mut client, channel).await?;
                client
                    .turn_start_json_stream(thread_id, message, images, model, effort)
                    .await?;
            }
            Err(error) => return Err(error),
        }
    } else if args.wait {
        let response = match client
            .turn_start_collect(
                thread_id.clone(),
                message.clone(),
                images.clone(),
                model.clone(),
                effort,
            )
            .await
        {
            Ok(response) => response,
            Err(error) if channel.is_some() && is_thread_not_found_error(&error) => {
                let channel = channel
                    .as_deref()
                    .context("channel is required for stale thread recovery")?;
                let thread_id = create_default_channel_thread(&mut client, channel).await?;
                client
                    .turn_start_collect(thread_id, message, images, model, effort)
                    .await?
            }
            Err(error) => return Err(error),
        };
        println!("{response}");
    } else {
        let response = match client
            .turn_start(
                thread_id.clone(),
                message.clone(),
                images.clone(),
                model.clone(),
                effort,
            )
            .await
        {
            Ok(response) => response,
            Err(error) if channel.is_some() && is_thread_not_found_error(&error) => {
                let channel = channel
                    .as_deref()
                    .context("channel is required for stale thread recovery")?;
                let thread_id = create_default_channel_thread(&mut client, channel).await?;
                client
                    .turn_start(thread_id, message, images, model, effort)
                    .await?
            }
            Err(error) => return Err(error),
        };
        serde_json::to_writer_pretty(std::io::stdout(), &response)?;
        println!();
    }
    Ok(())
}

async fn session_steer(args: SessionSteerArgs) -> Result<()> {
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
    let response = client
        .turn_steer(thread_id, args.turn_id, message, args.images)
        .await?;
    serde_json::to_writer_pretty(std::io::stdout(), &response)?;
    println!();
    Ok(())
}

async fn session_send_slash_command(
    endpoint: &str,
    channel: String,
    command: ChannelSlashCommand,
    wait: bool,
) -> Result<()> {
    let mut client = CodexRpcClient::connect(endpoint).await?;
    match command {
        ChannelSlashCommand::New { rest } | ChannelSlashCommand::Reset { rest } => {
            let thread_id = create_default_channel_thread(&mut client, &channel).await?;
            if rest.is_empty() {
                println!("Started a new Anya session for this channel.");
            } else if wait {
                let response = client
                    .turn_start_collect(thread_id, rest, Vec::new(), None, None)
                    .await?;
                println!("{response}");
            } else {
                let response = client
                    .turn_start(thread_id, rest, Vec::new(), None, None)
                    .await?;
                serde_json::to_writer_pretty(std::io::stdout(), &response)?;
                println!();
            }
        }
        ChannelSlashCommand::Stop => {
            println!("No active Anya reply is tracked by this CLI process.");
        }
        ChannelSlashCommand::Status => {
            let store = ChannelStore::load().await?;
            if let Some(thread_id) = store.resolve(&channel) {
                println!("Channel {channel} is bound to thread {thread_id}.");
            } else {
                println!("Channel {channel} is not bound to a session.");
            }
        }
        ChannelSlashCommand::Help => println!("{CHANNEL_SLASH_HELP}"),
    }
    Ok(())
}

async fn create_default_channel_thread(
    client: &mut CodexRpcClient,
    channel: &str,
) -> Result<String> {
    let response = client.thread_start(/*model*/ None, /*cwd*/ None).await?;
    let mut store = ChannelStore::load().await?;
    store.bind(channel.to_string(), response.thread.id.clone());
    store.save().await?;
    Ok(response.thread.id)
}

fn anya_full_access_config_overrides() -> CliConfigOverrides {
    CliConfigOverrides {
        raw_overrides: vec![
            "approval_policy=\"never\"".to_string(),
            "sandbox_mode=\"danger-full-access\"".to_string(),
        ],
    }
}

fn is_thread_not_found_error(error: &anyhow::Error) -> bool {
    error.to_string().contains("thread not found")
}

fn is_thread_unavailable_error(error: &anyhow::Error) -> bool {
    let message = error.to_string();
    message.contains("thread not found") || message.contains("no rollout found")
}

fn parse_channel_slash_command(message: &str) -> Option<ChannelSlashCommand> {
    let trimmed = message.trim();
    let without_slash = trimmed.strip_prefix('/')?;
    let split_at = without_slash
        .char_indices()
        .find_map(|(idx, ch)| ch.is_whitespace().then_some(idx))
        .unwrap_or(without_slash.len());
    let (name_token, rest) = without_slash.split_at(split_at);
    let name = name_token
        .split('@')
        .next()
        .unwrap_or(name_token)
        .trim_end_matches([':', ','])
        .to_ascii_lowercase();
    let rest = rest.trim().to_string();
    match name.as_str() {
        "new" => Some(ChannelSlashCommand::New { rest }),
        "reset" => Some(ChannelSlashCommand::Reset { rest }),
        "stop" => Some(ChannelSlashCommand::Stop),
        "status" => Some(ChannelSlashCommand::Status),
        "help" => Some(ChannelSlashCommand::Help),
        _ => None,
    }
}

async fn chat(args: ChatArgs) -> Result<()> {
    let channel = args.channel;
    let model = args.model;
    let cwd = args.cwd;
    let mut store = ChannelStore::load().await?;
    let mut client = CodexRpcClient::connect(&args.endpoint).await?;
    let mut thread_id = match store.resolve(&channel) {
        Some(thread_id) => thread_id.to_string(),
        None => {
            let response = client.thread_start(model.clone(), cwd.clone()).await?;
            let thread_id = response.thread.id;
            store.bind(channel.clone(), thread_id.clone());
            store.save().await?;
            thread_id
        }
    };
    client.thread_resume(thread_id.clone()).await?;

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
        if let Some(command) = parse_channel_slash_command(message) {
            match command {
                ChannelSlashCommand::New { rest } | ChannelSlashCommand::Reset { rest } => {
                    let response = client.thread_start(model.clone(), cwd.clone()).await?;
                    thread_id = response.thread.id;
                    store.bind(channel.clone(), thread_id.clone());
                    store.save().await?;
                    if rest.is_empty() {
                        println!("anya> Started a new Anya session for this channel.");
                    } else {
                        print!("anya> ");
                        std::io::stdout().flush()?;
                        client
                            .turn_start_streaming(thread_id.clone(), rest, Vec::new())
                            .await?;
                    }
                }
                ChannelSlashCommand::Stop => {
                    println!("anya> No active Anya reply is running in this chat.");
                }
                ChannelSlashCommand::Status => {
                    println!("anya> Channel {channel} is bound to thread {thread_id}.");
                }
                ChannelSlashCommand::Help => println!("anya> {CHANNEL_SLASH_HELP}"),
            }
            continue;
        }
        print!("anya> ");
        std::io::stdout().flush()?;
        match client
            .turn_start_streaming(thread_id.clone(), message.to_string(), Vec::new())
            .await
        {
            Ok(()) => {}
            Err(error) if is_thread_not_found_error(&error) => {
                let response = client.thread_start(model.clone(), cwd.clone()).await?;
                thread_id = response.thread.id;
                store.bind(channel.clone(), thread_id.clone());
                store.save().await?;
                client
                    .turn_start_streaming(thread_id.clone(), message.to_string(), Vec::new())
                    .await?;
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

async fn tui(args: TuiArgs, arg0_paths: Arg0DispatchPaths) -> Result<()> {
    let mut tui_cli = CodexTuiCli::parse_from(["anya-tui"]);
    tui_cli.dangerously_bypass_approvals_and_sandbox = true;
    tui_cli.approval_policy = Some(ApprovalModeCliArg::Never);
    tui_cli.sandbox_mode = Some(SandboxModeCliArg::DangerFullAccess);
    tui_cli.config_overrides = anya_full_access_config_overrides();
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

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn parses_channel_slash_commands() {
        assert_eq!(
            Some(ChannelSlashCommand::New {
                rest: "summarize recent commits".to_string(),
            }),
            parse_channel_slash_command("/new summarize recent commits")
        );
        assert_eq!(
            Some(ChannelSlashCommand::Reset {
                rest: "soft".to_string(),
            }),
            parse_channel_slash_command("/reset: soft")
        );
        assert_eq!(
            Some(ChannelSlashCommand::Stop),
            parse_channel_slash_command("/stop@anya")
        );
        assert_eq!(None, parse_channel_slash_command("/model gpt-5.5"));
    }

    #[test]
    fn parses_auth_status_command() {
        let cli = Cli::try_parse_from(["anya", "auth", "status"]).unwrap();
        match cli.command {
            CommandKind::Auth(AuthArgs {
                command: AuthCommand::Status(args),
            }) => {
                assert_eq!("ws://127.0.0.1:4827", args.endpoint);
                assert_eq!(45, args.timeout_secs);
            }
            other => panic!("unexpected command: {other:?}"),
        }
    }

    #[test]
    fn anya_full_access_config_overrides_force_unsandboxed_execution() {
        let overrides = anya_full_access_config_overrides()
            .parse_overrides()
            .expect("parse full access overrides");

        assert_eq!(2, overrides.len());
        assert_eq!("approval_policy", overrides[0].0);
        assert_eq!(Some("never"), overrides[0].1.as_str());
        assert_eq!("sandbox_mode", overrides[1].0);
        assert_eq!(Some("danger-full-access"), overrides[1].1.as_str());
    }
}
