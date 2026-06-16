#[cfg(unix)]
use std::os::unix::net::UnixStream;
#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use anyhow::Context;
use anyhow::Result;
use clap::Args;
use clap::Subcommand;
use clap::ValueEnum;
use serde::Deserialize;
use serde::Serialize;
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncWriteExt;
use tokio::io::BufReader;
use tokio::process::Child;
use tokio::process::Command;
use tokio::task::JoinHandle;

#[derive(Debug, Args)]
pub struct WhatsappArgs {
    #[command(subcommand)]
    command: WhatsappCommand,
}

#[derive(Debug, Subcommand)]
enum WhatsappCommand {
    /// Install the bridge and start a guided WhatsApp pairing flow.
    Setup(WhatsappSetupArgs),
    /// Install the Node/Baileys WhatsApp bridge files.
    Install(WhatsappInstallArgs),
    /// Run the WhatsApp bridge in the foreground.
    Bridge(WhatsappBridgeArgs),
    /// Print or update WhatsApp channel access config.
    Config(WhatsappConfigArgs),
    /// Send an outbound WhatsApp message through the running bridge.
    Send(WhatsappSendArgs),
    /// List known WhatsApp chats and contacts from the running bridge.
    Contacts(WhatsappContactsArgs),
    /// Read and sync recent messages for a WhatsApp chat.
    Read(WhatsappReadArgs),
    /// Temporarily allow/listen for inbound messages from a WhatsApp chat.
    Listen(WhatsappListenArgs),
}

#[derive(Debug, Args)]
struct WhatsappInstallArgs {
    #[arg(long)]
    dir: Option<PathBuf>,
    #[arg(long)]
    skip_npm_install: bool,
}

#[derive(Debug, Args)]
struct WhatsappSetupArgs {
    #[arg(long)]
    dir: Option<PathBuf>,
    #[arg(long, env = "ANYA_ENDPOINT", default_value = "ws://127.0.0.1:4827")]
    endpoint: String,
    #[arg(long, default_value = "whatsapp")]
    channel_prefix: String,
    #[arg(long, default_value = "anya")]
    bot_name: String,
    /// Request a WhatsApp "link with phone number" code instead of showing a QR.
    #[arg(long, value_name = "E164")]
    phone_number: Option<String>,
    #[arg(long)]
    anya_binary: Option<PathBuf>,
    /// Run the bridge directly in this terminal instead of configuring the Anya gateway service.
    #[arg(long)]
    foreground: bool,
    /// Install files and write gateway config without restarting anya.service.
    #[arg(long)]
    no_run: bool,
    /// Name of the existing systemd user service that runs `anya serve`.
    #[arg(long, default_value = "anya")]
    gateway_service_name: String,
    #[arg(long)]
    skip_npm_install: bool,
    /// DM access policy: open, allowlist, or disabled.
    #[arg(long, default_value = "open")]
    dm_policy: String,
    /// Group access policy: open, allowlist, or disabled.
    #[arg(long, default_value = "open")]
    group_policy: String,
    /// Allowed DM senders. Accepts E.164 numbers, raw digits, JIDs, or "*".
    #[arg(long, value_delimiter = ',')]
    allow_from: Vec<String>,
    /// Blocked senders. Deny wins over allow.
    #[arg(long, value_delimiter = ',')]
    block_from: Vec<String>,
    /// Allowed group senders for groupPolicy=allowlist. Falls back to allowFrom if empty.
    #[arg(long, value_delimiter = ',')]
    group_allow_from: Vec<String>,
    /// Allowed group chat JIDs. If set, groups not listed here are ignored unless "*" is listed.
    #[arg(long, value_delimiter = ',')]
    groups: Vec<String>,
    /// Require mention/name invocation in group chats.
    #[arg(long, default_value_t = true)]
    require_mention: bool,
}

#[derive(Debug, Args)]
struct WhatsappBridgeArgs {
    #[arg(long)]
    dir: Option<PathBuf>,
    #[arg(long, env = "ANYA_ENDPOINT", default_value = "ws://127.0.0.1:4827")]
    endpoint: String,
    #[arg(long, default_value = "whatsapp")]
    channel_prefix: String,
    #[arg(long, default_value = "anya")]
    bot_name: String,
    /// Request a WhatsApp "link with phone number" code instead of showing a QR.
    #[arg(long, env = "ANYA_WHATSAPP_PAIR_PHONE", value_name = "E164")]
    phone_number: Option<String>,
    #[arg(long)]
    anya_binary: Option<PathBuf>,
}

#[derive(Debug, Args)]
struct WhatsappConfigArgs {
    #[command(subcommand)]
    command: WhatsappConfigCommand,
}

#[derive(Debug, Subcommand)]
enum WhatsappConfigCommand {
    /// Print the persisted WhatsApp bridge config.
    Print {
        #[arg(long)]
        dir: Option<PathBuf>,
    },
    /// Update persisted WhatsApp access config. Omitted fields are left unchanged.
    Set(WhatsappConfigSetArgs),
}

#[derive(Debug, Args)]
struct WhatsappConfigSetArgs {
    #[arg(long)]
    dir: Option<PathBuf>,
    #[arg(long)]
    dm_policy: Option<String>,
    #[arg(long)]
    group_policy: Option<String>,
    #[arg(long, value_delimiter = ',')]
    allow_from: Option<Vec<String>>,
    #[arg(long, value_delimiter = ',')]
    block_from: Option<Vec<String>>,
    #[arg(long, value_delimiter = ',')]
    group_allow_from: Option<Vec<String>>,
    #[arg(long, value_delimiter = ',')]
    groups: Option<Vec<String>>,
    #[arg(long)]
    require_mention: Option<bool>,
}

#[derive(Debug, Args)]
struct WhatsappSendArgs {
    /// Phone number, WhatsApp JID, or known contact/chat name.
    #[arg(long)]
    to: String,
    /// Keep inbound handling open for this peer after sending.
    #[arg(long, default_value_t = 0)]
    listen_secs: u64,
    /// Attach one or more local files/media items to send.
    #[arg(long = "file", value_name = "PATH")]
    files: Vec<PathBuf>,
    /// How to send attached files. Auto infers from file extension.
    #[arg(long, value_enum, default_value = "auto")]
    media_kind: WhatsappMediaKind,
    /// Message text to send, or caption for the first attached file.
    #[arg(trailing_var_arg = true)]
    message: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
enum WhatsappMediaKind {
    Auto,
    Document,
    Image,
    Video,
    Audio,
    Voice,
}

impl WhatsappMediaKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Document => "document",
            Self::Image => "image",
            Self::Video => "video",
            Self::Audio => "audio",
            Self::Voice => "voice",
        }
    }
}

#[derive(Debug, Args)]
struct WhatsappContactsArgs {
    /// Optional case-insensitive name/JID/number filter.
    #[arg(long)]
    query: Option<String>,
}

#[derive(Debug, Args)]
struct WhatsappReadArgs {
    /// Phone number, WhatsApp JID, or known contact/chat name.
    #[arg(long)]
    chat: String,
    #[arg(long, default_value_t = 20)]
    limit: u32,
    /// Optional WhatsApp message ID to locate in recorded/synced chat history.
    #[arg(long)]
    message_id: Option<String>,
    /// Number of messages on each side to return when --message-id is found.
    #[arg(long, default_value_t = 10)]
    around: u32,
}

#[derive(Debug, Args)]
struct WhatsappListenArgs {
    /// Phone number, WhatsApp JID, or known contact/chat name.
    #[arg(long)]
    chat: String,
    #[arg(long, default_value_t = 300)]
    seconds: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct WhatsappBridgeConfig {
    endpoint: String,
    channel_prefix: String,
    bot_name: String,
    phone_number: Option<String>,
    #[serde(default = "default_open_policy")]
    dm_policy: String,
    #[serde(default = "default_open_policy")]
    group_policy: String,
    #[serde(default)]
    allow_from: Vec<String>,
    #[serde(default)]
    block_from: Vec<String>,
    #[serde(default)]
    group_allow_from: Vec<String>,
    #[serde(default)]
    groups: Vec<String>,
    #[serde(default = "default_require_mention")]
    require_mention: bool,
}

pub async fn run(args: WhatsappArgs) -> Result<()> {
    match args.command {
        WhatsappCommand::Setup(args) => setup(args).await,
        WhatsappCommand::Install(args) => install(args).await,
        WhatsappCommand::Bridge(args) => bridge(args).await,
        WhatsappCommand::Config(args) => config(args).await,
        WhatsappCommand::Send(args) => whatsapp_send(args).await,
        WhatsappCommand::Contacts(args) => whatsapp_contacts(args).await,
        WhatsappCommand::Read(args) => whatsapp_read(args).await,
        WhatsappCommand::Listen(args) => whatsapp_listen(args).await,
    }
}

async fn install(args: WhatsappInstallArgs) -> Result<()> {
    let dir = bridge_dir(args.dir)?;
    install_bridge_files(&dir, args.skip_npm_install).await?;
    println!("{}", dir.display());
    Ok(())
}

async fn setup(args: WhatsappSetupArgs) -> Result<()> {
    if !args.foreground && !cfg!(target_os = "linux") {
        anyhow::bail!(
            "gateway service setup requires Linux systemd; pass --foreground to run the bridge directly"
        );
    }
    let dir = bridge_dir(args.dir)?;
    install_bridge_files(&dir, args.skip_npm_install).await?;

    let anya_binary = resolve_anya_binary(args.anya_binary);
    let config = WhatsappBridgeConfig {
        endpoint: args.endpoint,
        channel_prefix: args.channel_prefix,
        bot_name: args.bot_name,
        phone_number: normalize_pair_phone_number(args.phone_number)?,
        dm_policy: normalize_policy(&args.dm_policy, "dm-policy")?,
        group_policy: normalize_policy(&args.group_policy, "group-policy")?,
        allow_from: normalize_list(args.allow_from),
        block_from: normalize_list(args.block_from),
        group_allow_from: normalize_list(args.group_allow_from),
        groups: normalize_list(args.groups),
        require_mention: args.require_mention,
    };

    println!("WhatsApp bridge installed in {}", dir.display());
    if config.phone_number.is_some() {
        println!(
            "Use the pairing code printed below from WhatsApp > Linked devices > Link with phone number instead."
        );
    } else {
        println!("If a QR code is shown, scan it from WhatsApp > Linked devices.");
    }

    if !args.foreground {
        write_config(&dir, &config).await?;
        println!("WhatsApp channel configured for the Anya gateway service.");
        if args.no_run {
            print_setup_next_steps(&args.gateway_service_name);
            return Ok(());
        }
        let since = unix_timestamp_secs()?;
        restart_gateway_service(&args.gateway_service_name).await?;
        println!(
            "WhatsApp bridge is running inside {}.service. Showing setup logs; this command exits after the bridge connects.",
            args.gateway_service_name
        );
        println!("Press Ctrl-C to stop watching logs; the Anya gateway service will keep running.");
        return follow_gateway_setup_logs(&args.gateway_service_name, since).await;
    }

    bridge(WhatsappBridgeArgs {
        dir: Some(dir),
        endpoint: config.endpoint,
        channel_prefix: config.channel_prefix,
        bot_name: config.bot_name,
        phone_number: config.phone_number,
        anya_binary: Some(anya_binary),
    })
    .await
}

async fn config(args: WhatsappConfigArgs) -> Result<()> {
    match args.command {
        WhatsappConfigCommand::Print { dir } => {
            let dir = bridge_dir(dir)?;
            let config = read_config(&dir).await?;
            serde_json::to_writer_pretty(std::io::stdout(), &config)?;
            println!();
        }
        WhatsappConfigCommand::Set(args) => {
            let dir = bridge_dir(args.dir)?;
            let mut config = read_config(&dir).await?;
            if let Some(policy) = args.dm_policy {
                config.dm_policy = normalize_policy(&policy, "dm-policy")?;
            }
            if let Some(policy) = args.group_policy {
                config.group_policy = normalize_policy(&policy, "group-policy")?;
            }
            if let Some(list) = args.allow_from {
                config.allow_from = normalize_list(list);
            }
            if let Some(list) = args.block_from {
                config.block_from = normalize_list(list);
            }
            if let Some(list) = args.group_allow_from {
                config.group_allow_from = normalize_list(list);
            }
            if let Some(list) = args.groups {
                config.groups = normalize_list(list);
            }
            if let Some(require_mention) = args.require_mention {
                config.require_mention = require_mention;
            }
            write_config(&dir, &config).await?;
            serde_json::to_writer_pretty(std::io::stdout(), &config)?;
            println!();
        }
    }
    Ok(())
}

pub async fn spawn_gateway_bridge(default_endpoint: &str) -> Result<Option<JoinHandle<()>>> {
    let dir = bridge_dir(None)?;
    let config_path = config_path(&dir);
    if !config_path.exists() {
        return Ok(None);
    }
    let mut config = read_config(&dir).await?;
    if config.endpoint.is_empty() {
        config.endpoint = default_endpoint.to_string();
    }
    let anya_binary = resolve_anya_binary(None);
    let handle = tokio::spawn(async move {
        loop {
            match spawn_bridge_process(&dir, &anya_binary, &config).await {
                Ok(mut child) => match child.wait().await {
                    Ok(status) => {
                        if bridge_was_terminated_for_shutdown(status) {
                            eprintln!(
                                "Anya WhatsApp bridge terminated for shutdown; not restarting"
                            );
                            break;
                        }
                        eprintln!("Anya WhatsApp bridge exited with {status}; restarting in 2s");
                    }
                    Err(error) => {
                        eprintln!(
                            "Failed to wait for Anya WhatsApp bridge: {error}; restarting in 2s"
                        );
                    }
                },
                Err(error) => {
                    eprintln!("Failed to start Anya WhatsApp bridge: {error}; retrying in 2s");
                }
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
    Ok(Some(handle))
}

fn bridge_was_terminated_for_shutdown(status: std::process::ExitStatus) -> bool {
    #[cfg(unix)]
    {
        status.signal() == Some(15)
    }
    #[cfg(not(unix))]
    {
        let _ = status;
        false
    }
}

async fn install_bridge_files(dir: &std::path::Path, skip_npm_install: bool) -> Result<()> {
    tokio::fs::create_dir_all(&dir).await?;
    write_file(dir.join("package.json"), PACKAGE_JSON).await?;
    write_file(dir.join("bridge.mjs"), BRIDGE_MJS).await?;

    if !skip_npm_install {
        let status = Command::new("npm")
            .arg("install")
            .current_dir(dir)
            .stdin(Stdio::null())
            .status()
            .await
            .context("run npm install for WhatsApp bridge")?;
        if !status.success() {
            anyhow::bail!("npm install failed with {status}");
        }
    }
    Ok(())
}

async fn bridge(args: WhatsappBridgeArgs) -> Result<()> {
    let dir = bridge_dir(args.dir)?;
    if !dir.join("bridge.mjs").exists() {
        install_bridge_files(&dir, false).await?;
    }

    let anya_binary = resolve_anya_binary(args.anya_binary);
    let config = WhatsappBridgeConfig {
        endpoint: args.endpoint,
        channel_prefix: args.channel_prefix,
        bot_name: args.bot_name,
        phone_number: normalize_pair_phone_number(args.phone_number)?,
        dm_policy: default_open_policy(),
        group_policy: default_open_policy(),
        allow_from: Vec::new(),
        block_from: Vec::new(),
        group_allow_from: Vec::new(),
        groups: Vec::new(),
        require_mention: default_require_mention(),
    };
    let status = bridge_command(&dir, &anya_binary, &config)
        .status()
        .await
        .context("run WhatsApp bridge")?;
    if !status.success() {
        anyhow::bail!("WhatsApp bridge exited with {status}");
    }
    Ok(())
}

async fn spawn_bridge_process(
    dir: &std::path::Path,
    binary: &std::path::Path,
    config: &WhatsappBridgeConfig,
) -> Result<Child> {
    bridge_command(dir, binary, config)
        .kill_on_drop(true)
        .spawn()
        .context("start WhatsApp bridge")
}

fn bridge_command(
    dir: &std::path::Path,
    binary: &std::path::Path,
    config: &WhatsappBridgeConfig,
) -> Command {
    let mut command = Command::new("node");
    command
        .arg(dir.join("bridge.mjs"))
        .env("ANYA_BINARY", binary)
        .env("ANYA_ENDPOINT", &config.endpoint)
        .env("ANYA_CHANNEL_PREFIX", &config.channel_prefix)
        .env("ANYA_BOT_NAME", &config.bot_name)
        .env("ANYA_WHATSAPP_SESSION_DIR", dir.join("session"))
        .env("ANYA_WHATSAPP_CONTROL_SOCKET", control_socket_path(dir))
        .env("ANYA_WHATSAPP_DM_POLICY", &config.dm_policy)
        .env("ANYA_WHATSAPP_GROUP_POLICY", &config.group_policy)
        .env("ANYA_WHATSAPP_ALLOW_FROM", config.allow_from.join(","))
        .env("ANYA_WHATSAPP_BLOCK_FROM", config.block_from.join(","))
        .env(
            "ANYA_WHATSAPP_GROUP_ALLOW_FROM",
            config.group_allow_from.join(","),
        )
        .env("ANYA_WHATSAPP_GROUPS", config.groups.join(","))
        .env(
            "ANYA_WHATSAPP_REQUIRE_MENTION",
            if config.require_mention { "1" } else { "0" },
        )
        .current_dir(dir);
    if let Some(phone_number) = &config.phone_number {
        command.env("ANYA_WHATSAPP_PAIR_PHONE", phone_number);
    }
    command
}

async fn restart_gateway_service(service_name: &str) -> Result<()> {
    let service_unit = service_unit_name(service_name);
    crate::service::restart_user_systemd_unit(&service_unit).await?;
    Ok(())
}

async fn follow_gateway_setup_logs(service_name: &str, since: u64) -> Result<()> {
    let service_unit = service_unit_name(service_name);
    let mut child = Command::new("journalctl")
        .args(["--user", "-u", &service_unit, "--since"])
        .arg(format!("@{since}"))
        .args(["-f", "-o", "cat"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .with_context(|| format!("follow logs for {service_unit}"))?;
    let stdout = child.stdout.take().context("capture journalctl stdout")?;
    let mut lines = BufReader::new(stdout).lines();
    while let Some(line) = lines.next_line().await? {
        println!("{line}");
        if line.contains("Anya WhatsApp bridge connected.") {
            child.start_kill().ok();
            let _ = child.wait().await;
            return Ok(());
        }
        if line.contains("WhatsApp logged out.") {
            child.start_kill().ok();
            let _ = child.wait().await;
            anyhow::bail!("WhatsApp logged out. Remove the session directory and pair again.");
        }
    }
    let status = child.wait().await.context("wait for journalctl")?;
    if !status.success() {
        anyhow::bail!("journalctl exited with {status}");
    }
    Ok(())
}

fn unix_timestamp_secs() -> Result<u64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("current time is before Unix epoch")?
        .as_secs())
}

fn service_unit_name(service_name: &str) -> String {
    if service_name.ends_with(".service") {
        service_name.to_string()
    } else {
        format!("{service_name}.service")
    }
}

fn print_setup_next_steps(service_name: &str) {
    let service_unit = service_unit_name(service_name);
    println!("Next steps:");
    println!("  anya service restart --name {service_unit}");
    println!("  journalctl --user -u {service_unit} -f");
}

fn resolve_anya_binary(explicit: Option<PathBuf>) -> PathBuf {
    explicit.unwrap_or_else(|| std::env::current_exe().unwrap_or_else(|_| PathBuf::from("anya")))
}

fn normalize_pair_phone_number(phone_number: Option<String>) -> Result<Option<String>> {
    let Some(phone_number) = phone_number else {
        return Ok(None);
    };
    let digits: String = phone_number.chars().filter(char::is_ascii_digit).collect();
    if digits.len() < 8 {
        anyhow::bail!("--phone-number must include a country code, e.g. +15551234567");
    }
    Ok(Some(digits))
}

fn default_open_policy() -> String {
    "open".to_string()
}

fn default_require_mention() -> bool {
    true
}

fn normalize_policy(value: &str, name: &str) -> Result<String> {
    let normalized = value.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "open" | "allowlist" | "disabled" => Ok(normalized),
        _ => anyhow::bail!("{name} must be one of: open, allowlist, disabled"),
    }
}

fn normalize_list(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect()
}

async fn write_file(path: PathBuf, contents: &str) -> Result<()> {
    let mut file = tokio::fs::File::create(&path)
        .await
        .with_context(|| format!("create {}", path.display()))?;
    file.write_all(contents.as_bytes())
        .await
        .with_context(|| format!("write {}", path.display()))
}

fn bridge_dir(explicit: Option<PathBuf>) -> Result<PathBuf> {
    if let Some(dir) = explicit {
        return Ok(dir);
    }
    let base = dirs::data_dir().context("resolve user data directory")?;
    Ok(base.join("anya").join("whatsapp"))
}

fn config_path(dir: &std::path::Path) -> PathBuf {
    dir.join("config.json")
}

fn control_socket_path(dir: &std::path::Path) -> PathBuf {
    dir.join("control.sock")
}

async fn whatsapp_send(args: WhatsappSendArgs) -> Result<()> {
    let text = args.message.join(" ");
    if text.trim().is_empty() && args.files.is_empty() {
        anyhow::bail!("message or --file must not be empty");
    }
    let attachments = args
        .files
        .iter()
        .map(|path| {
            let path_text = path.to_str().with_context(|| {
                format!("attachment path is not valid UTF-8: {}", path.display())
            })?;
            Ok(serde_json::json!({
                "path": path_text,
                "mediaKind": args.media_kind.as_str(),
            }))
        })
        .collect::<Result<Vec<_>>>()?;
    let response = whatsapp_control_request(serde_json::json!({
        "action": "send",
        "to": args.to,
        "text": text,
        "attachments": attachments,
        "listenSecs": args.listen_secs,
    }))?;
    print_control_response(response)
}

pub(crate) fn send_text_via_control(to: &str, text: &str) -> Result<()> {
    whatsapp_control_request(serde_json::json!({
        "action": "send",
        "to": to,
        "text": text,
        "attachments": [],
        "listenSecs": 0,
    }))
    .map(|_| ())
}

async fn whatsapp_contacts(args: WhatsappContactsArgs) -> Result<()> {
    let response = whatsapp_control_request(serde_json::json!({
        "action": "contacts",
        "query": args.query,
    }))?;
    print_control_response(response)
}

async fn whatsapp_read(args: WhatsappReadArgs) -> Result<()> {
    let response = whatsapp_control_request(serde_json::json!({
        "action": "read",
        "chat": args.chat,
        "limit": args.limit,
        "messageId": args.message_id,
        "around": args.around,
    }))?;
    print_control_response(response)
}

async fn whatsapp_listen(args: WhatsappListenArgs) -> Result<()> {
    let response = whatsapp_control_request(serde_json::json!({
        "action": "listen",
        "chat": args.chat,
        "seconds": args.seconds,
    }))?;
    print_control_response(response)
}

fn whatsapp_control_request(request: serde_json::Value) -> Result<serde_json::Value> {
    #[cfg(not(unix))]
    {
        let _ = request;
        anyhow::bail!("WhatsApp control commands require Unix domain sockets");
    }
    #[cfg(unix)]
    {
        use std::io::BufRead as _;
        use std::io::Write as _;

        let dir = bridge_dir(None)?;
        let socket_path = control_socket_path(&dir);
        let mut stream = UnixStream::connect(&socket_path).with_context(|| {
            format!(
                "connect to WhatsApp bridge control socket {}",
                socket_path.display()
            )
        })?;
        writeln!(stream, "{request}").context("write WhatsApp control request")?;
        let mut reader = std::io::BufReader::new(stream);
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .context("read WhatsApp control response")?;
        let response: serde_json::Value =
            serde_json::from_str(&line).context("parse WhatsApp control response")?;
        if response
            .get("ok")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
        {
            Ok(response)
        } else {
            let message = response
                .get("error")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("WhatsApp bridge control request failed");
            anyhow::bail!("{message}");
        }
    }
}

fn print_control_response(response: serde_json::Value) -> Result<()> {
    serde_json::to_writer_pretty(std::io::stdout(), &response)?;
    println!();
    Ok(())
}

async fn read_config(dir: &std::path::Path) -> Result<WhatsappBridgeConfig> {
    let path = config_path(dir);
    let contents = tokio::fs::read_to_string(&path)
        .await
        .with_context(|| format!("read {}", path.display()))?;
    serde_json::from_str(&contents).with_context(|| format!("parse {}", path.display()))
}

async fn write_config(dir: &std::path::Path, config: &WhatsappBridgeConfig) -> Result<()> {
    let contents = serde_json::to_string_pretty(config).context("serialize WhatsApp config")?;
    write_file(config_path(dir), &(contents + "\n")).await
}

const PACKAGE_JSON: &str = r#"{
  "private": true,
  "type": "module",
  "dependencies": {
    "@whiskeysockets/baileys": "^6.7.18",
    "pino": "^9.5.0",
    "qrcode-terminal": "^0.12.0"
  }
}
"#;

const BRIDGE_MJS: &str = r#"import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadContentFromMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import Pino from 'pino';
import qrcode from 'qrcode-terminal';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';

const anyaBinary = process.env.ANYA_BINARY || 'anya';
const endpoint = process.env.ANYA_ENDPOINT || 'ws://127.0.0.1:4827';
const channelPrefix = process.env.ANYA_CHANNEL_PREFIX || 'whatsapp';
const botName = (process.env.ANYA_BOT_NAME || 'anya').toLowerCase();
const dmPolicy = normalizePolicy(process.env.ANYA_WHATSAPP_DM_POLICY, 'open');
const groupPolicy = normalizePolicy(process.env.ANYA_WHATSAPP_GROUP_POLICY, 'open');
const allowFrom = parseListEnv(process.env.ANYA_WHATSAPP_ALLOW_FROM);
const blockFrom = parseListEnv(process.env.ANYA_WHATSAPP_BLOCK_FROM);
const groupAllowFrom = parseListEnv(process.env.ANYA_WHATSAPP_GROUP_ALLOW_FROM);
const allowedGroups = parseListEnv(process.env.ANYA_WHATSAPP_GROUPS);
const requireMention = parseBoolEnv(process.env.ANYA_WHATSAPP_REQUIRE_MENTION, true);
const pairPhoneNumber = (process.env.ANYA_WHATSAPP_PAIR_PHONE || '').replace(/\D/g, '');
const commandTimeoutMs = parseTimeout(
  process.env.ANYA_WHATSAPP_COMMAND_TIMEOUT_MS,
  30_000
);
const updateTimeoutMs = parseTimeout(
  process.env.ANYA_WHATSAPP_UPDATE_TIMEOUT_MS,
  20 * 60 * 1000
);
const deviceLoginTimeoutMs = parseTimeout(
  process.env.ANYA_WHATSAPP_DEVICE_LOGIN_TIMEOUT_MS,
  16 * 60 * 1000
);
const deviceLoginPromptTimeoutMs = parseTimeout(
  process.env.ANYA_WHATSAPP_DEVICE_LOGIN_PROMPT_TIMEOUT_MS,
  30_000
);
const authPreflightTtlMs = parseTimeout(
  process.env.ANYA_WHATSAPP_AUTH_PREFLIGHT_TTL_MS,
  5 * 60 * 1000
);
const authPreflightFailureTtlMs = parseTimeout(
  process.env.ANYA_WHATSAPP_AUTH_PREFLIGHT_FAILURE_TTL_MS,
  60_000
);
const authPreflightTimeoutMs = parseTimeout(
  process.env.ANYA_WHATSAPP_AUTH_PREFLIGHT_TIMEOUT_MS,
  25_000
);
const replyTimeoutMs = parseOptionalTimeout(process.env.ANYA_WHATSAPP_REPLY_TIMEOUT_MS);
const transcribeAudio = parseBoolEnv(process.env.ANYA_WHATSAPP_TRANSCRIBE_AUDIO, true);
const transcribeTimeoutMs = parseTimeout(
  process.env.ANYA_WHATSAPP_TRANSCRIBE_TIMEOUT_MS,
  180_000
);
const transcribeModel = process.env.ANYA_WHATSAPP_TRANSCRIBE_MODEL || 'tiny';
const transcriberVenv =
  process.env.ANYA_WHATSAPP_TRANSCRIBE_VENV ||
  join(tmpdir(), 'anya-whatsapp-stt-venv');
const sessionDir =
  process.env.ANYA_WHATSAPP_SESSION_DIR ||
  join(process.env.HOME || '.', '.local', 'share', 'anya', 'whatsapp', 'session');
const mediaDir =
  process.env.ANYA_WHATSAPP_MEDIA_DIR ||
  join(process.env.HOME || '.', '.local', 'share', 'anya', 'whatsapp', 'media');
const channelSettingsPath =
  process.env.ANYA_WHATSAPP_CHANNEL_SETTINGS_PATH ||
  join(process.env.HOME || '.', '.local', 'share', 'anya', 'whatsapp', 'channel-settings.json');
const controlSocketPath =
  process.env.ANYA_WHATSAPP_CONTROL_SOCKET ||
  join(process.env.HOME || '.', '.local', 'share', 'anya', 'whatsapp', 'control.sock');
const messageLogPath =
  process.env.ANYA_WHATSAPP_MESSAGE_LOG_PATH ||
  join(process.env.HOME || '.', '.local', 'share', 'anya', 'whatsapp', 'message-log.json');
const bridgeNoticePath =
  process.env.ANYA_WHATSAPP_BRIDGE_NOTICE_PATH ||
  join(process.env.HOME || '.', '.local', 'share', 'anya', 'whatsapp', 'bridge-notices.json');
const historySyncWaitMs = parseTimeout(process.env.ANYA_WHATSAPP_HISTORY_SYNC_WAIT_MS, 12_000);
const maxMediaBytes = parseTimeout(process.env.ANYA_WHATSAPP_MAX_MEDIA_BYTES, 25 * 1024 * 1024);
const streamReplies = parseBoolEnv(process.env.ANYA_WHATSAPP_STREAM_REPLIES, true);
const streamFlushMs = parseTimeout(process.env.ANYA_WHATSAPP_STREAM_FLUSH_MS, 1_200);
const streamFlushChars = parseTimeout(process.env.ANYA_WHATSAPP_STREAM_FLUSH_CHARS, 600);
const sendRetryMs = parseTimeout(process.env.ANYA_WHATSAPP_SEND_RETRY_MS, 2_000);
const activeRuns = new Map();
const knownContacts = new Map();
const knownChats = new Map();
const temporaryInboundAllows = new Map();
const pendingHistoryReads = new Map();
let activeDeviceLogin = false;
let activeUpdate = false;
let authPreflight = {
  okUntil: 0,
  failureUntil: 0,
  failure: null,
  pending: null,
};
let channelSettings = loadChannelSettings();
let messageLog = loadMessageLog();
let bridgeNotices = loadBridgeNotices();
let currentSock = null;
let controlServer = null;
let reconnectScheduled = false;

mkdirSync(sessionDir, { recursive: true });
mkdirSync(mediaDir, { recursive: true });
mkdirSync(dirname(controlSocketPath), { recursive: true });
mkdirSync(dirname(messageLogPath), { recursive: true });
mkdirSync(dirname(bridgeNoticePath), { recursive: true });

class AnyaRunStoppedError extends Error {
  constructor() {
    super('Stopped by /stop');
    this.name = 'AnyaRunStoppedError';
  }
}

function parseTimeout(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalTimeout(value) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseListEnv(value) {
  return (value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseBoolEnv(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function normalizePolicy(value, fallback) {
  const normalized = String(value || fallback).trim().toLowerCase();
  return ['open', 'allowlist', 'disabled'].includes(normalized) ? normalized : fallback;
}

function loadChannelSettings() {
  try {
    return JSON.parse(readFileSync(channelSettingsPath, 'utf8'));
  } catch {
    return {};
  }
}

function loadMessageLog() {
  try {
    const parsed = JSON.parse(readFileSync(messageLogPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function loadBridgeNotices() {
  try {
    const parsed = JSON.parse(readFileSync(bridgeNoticePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveMessageLog() {
  mkdirSync(dirname(messageLogPath), { recursive: true });
  writeFileSync(messageLogPath, JSON.stringify(messageLog, null, 2));
}

function saveBridgeNotices() {
  mkdirSync(dirname(bridgeNoticePath), { recursive: true });
  writeFileSync(bridgeNoticePath, JSON.stringify(bridgeNotices, null, 2));
}

function saveChannelSettings() {
  mkdirSync(dirname(channelSettingsPath), { recursive: true });
  writeFileSync(channelSettingsPath, JSON.stringify(channelSettings, null, 2));
}

function settingsForChannel(channel) {
  const settings = channelSettings[channel];
  return settings && typeof settings === 'object' ? settings : {};
}

function updateChannelSettings(channel, patch) {
  const next = {
    ...settingsForChannel(channel),
    ...patch,
  };
  for (const key of Object.keys(next)) {
    if (next[key] === null || next[key] === undefined || next[key] === '') delete next[key];
  }
  if (Object.keys(next).length === 0) delete channelSettings[channel];
  else channelSettings[channel] = next;
  saveChannelSettings();
  return settingsForChannel(channel);
}

function normalizeReasoningEffort(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['default', 'unset', 'clear'].includes(normalized)) return null;
  if (['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(normalized)) {
    return normalized;
  }
  throw new Error('Reasoning effort must be one of: none, minimal, low, medium, high, xhigh, default.');
}

function normalizeServiceTier(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['default', 'unset', 'clear'].includes(normalized)) return null;
  if (['off', 'false', 'disabled'].includes(normalized)) return 'default';
  if (['on', 'true', 'enabled', 'fast'].includes(normalized)) return 'fast';
  if (/^[a-z0-9][a-z0-9._-]*$/i.test(normalized)) return normalized;
  throw new Error('Service tier must be fast, default, off, or a valid service tier id.');
}

function describeChannelSettings(channel) {
  const settings = settingsForChannel(channel);
  const fastMode = settings.serviceTier === 'fast' ? 'on' : settings.serviceTier || 'default';
  return `Model: ${settings.model || 'default'}. Thinking: ${settings.effort || 'default'}. Fast: ${fastMode}.`;
}

function runProcess(command, args, options = {}) {
  const timeoutMs = options.timeoutMs || commandTimeoutMs;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let sentSignal = false;
    let killTimer;
    const stopChild = () => {
      if (child.exitCode !== null || sentSignal) return;
      child.kill('SIGTERM');
      sentSignal = true;
      killTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 2_000);
      killTimer.unref?.();
    };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      fn(value);
    };
    const timeout = setTimeout(() => {
      stopChild();
      settle(reject, new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    timeout.unref?.();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 10 * 1024 * 1024) {
        stopChild();
        settle(reject, new Error(`${command} stdout exceeded 10 MiB`));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 10 * 1024 * 1024) {
        stopChild();
        settle(reject, new Error(`${command} stderr exceeded 10 MiB`));
      }
    });
    child.on('error', (error) => settle(reject, error));
    child.on('close', (code, signal) => {
      if (settled) return;
      if (code === 0) {
        settle(resolve, stdout);
        return;
      }
      const detail = stderr.trim() || stdout.trim() || `${command} exited with ${code ?? signal}`;
      settle(reject, new Error(detail));
    });
  });
}

function runAnya(args, options = {}) {
  const timeoutMs = options.timeoutMs || commandTimeoutMs;
  const activeKey = options.activeKey;
  return new Promise((resolve, reject) => {
    const child = spawn(anyaBinary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let sentSignal = false;
    let killTimer;

    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      if (activeKey && activeRuns.get(activeKey)?.child === child) {
        activeRuns.delete(activeKey);
      }
    };
    const stopChild = () => {
      if (child.exitCode !== null || sentSignal) return;
      child.kill('SIGTERM');
      sentSignal = true;
      killTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 2_000);
      killTimer.unref?.();
    };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const fail = (error) => settle(reject, error);

    const timeout = setTimeout(() => {
      stopChild();
      fail(new Error(`Anya command timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    timeout.unref?.();

    if (activeKey) {
      activeRuns.set(activeKey, {
        child,
        turnId: null,
        stop: () => {
          stopChild();
          fail(new AnyaRunStoppedError());
        },
      });
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 10 * 1024 * 1024) {
        stopChild();
        fail(new Error('Anya stdout exceeded 10 MiB'));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 10 * 1024 * 1024) {
        stopChild();
        fail(new Error('Anya stderr exceeded 10 MiB'));
      }
    });
    child.on('error', fail);
    child.on('close', (code, signal) => {
      if (settled) return;
      if (code === 0) {
        settle(resolve, stdout);
        return;
      }
      const detail = stderr.trim() || stdout.trim() || `anya exited with ${code ?? signal}`;
      fail(new Error(detail));
    });
  });
}

function streamAnya(args, callbacks, options = {}) {
  const activeKey = options.activeKey;
  const timeoutMs = options.timeoutMs ?? null;
  return new Promise((resolve, reject) => {
    const child = spawn(anyaBinary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let lineBuffer = '';
    let stderr = '';
    let settled = false;
    let sentSignal = false;
    let timeout;
    let killTimer;

    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      if (activeKey && activeRuns.get(activeKey)?.child === child) {
        activeRuns.delete(activeKey);
      }
    };
    const stopChild = () => {
      if (child.exitCode !== null || sentSignal) return;
      child.kill('SIGTERM');
      sentSignal = true;
      killTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 2_000);
      killTimer.unref?.();
    };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const fail = (error) => settle(reject, error);

    if (timeoutMs) {
      timeout = setTimeout(() => {
        stopChild();
        fail(new Error(`Anya command timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      timeout.unref?.();
    }

    if (activeKey) {
      activeRuns.set(activeKey, {
        child,
        turnId: null,
        stop: () => {
          stopChild();
          fail(new AnyaRunStoppedError());
        },
      });
    }

    const handleLine = (line) => {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        callbacks.onMessageDelta?.(line);
        return;
      }
      if (event.type === 'message_delta') {
        callbacks.onMessageDelta?.(event.delta || '', event);
      } else {
        callbacks.onActivity?.(event);
      }
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      lineBuffer += chunk;
      if (lineBuffer.length > 10 * 1024 * 1024) {
        stopChild();
        fail(new Error('Anya stream exceeded 10 MiB without a newline'));
        return;
      }
      let newlineIndex;
      while ((newlineIndex = lineBuffer.indexOf('\n')) !== -1) {
        const line = lineBuffer.slice(0, newlineIndex);
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        handleLine(line);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 10 * 1024 * 1024) {
        stopChild();
        fail(new Error('Anya stderr exceeded 10 MiB'));
      }
    });
    child.on('error', fail);
    child.on('close', (code, signal) => {
      if (settled) return;
      if (lineBuffer.trim()) handleLine(lineBuffer);
      if (code === 0) {
        settle(resolve);
        return;
      }
      const detail = stderr.trim() || `anya exited with ${code ?? signal}`;
      fail(new Error(detail));
    });
  });
}

function channelName(remoteJid) {
  return `${channelPrefix}:${remoteJid}`;
}

function displayNameForJid(jid) {
  return knownContacts.get(jid)?.name || knownChats.get(jid)?.name || jid;
}

function normalizeWhatsappJid(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.includes('@')) return raw.toLowerCase();
  const digits = raw.replace(/\D/g, '');
  return digits ? `${digits}@s.whatsapp.net` : '';
}

function rememberContact(jid, patch = {}) {
  if (!jid) return;
  const current = knownContacts.get(jid) || { jid };
  const name = patch.name || patch.notify || patch.verifiedName || current.name || jid;
  knownContacts.set(jid, {
    jid,
    name,
    notify: patch.notify || current.notify || null,
    verifiedName: patch.verifiedName || current.verifiedName || null,
  });
}

function rememberChat(jid, patch = {}) {
  if (!jid) return;
  const current = knownChats.get(jid) || { jid };
  const name = patch.name || patch.subject || patch.notify || current.name || displayNameForJid(jid);
  knownChats.set(jid, {
    jid,
    name,
    subject: patch.subject || current.subject || null,
    lastMessageAt: patch.lastMessageAt || patch.conversationTimestamp || current.lastMessageAt || null,
  });
}

function allKnownPeers() {
  const peers = new Map();
  for (const [jid, contact] of knownContacts) peers.set(jid, { ...contact, jid, source: 'contact' });
  for (const [jid, chat] of knownChats) {
    peers.set(jid, { ...peers.get(jid), ...chat, jid, source: peers.has(jid) ? 'contact+chat' : 'chat' });
  }
  for (const [jid, messages] of Object.entries(messageLog)) {
    const latest = Array.isArray(messages) ? messages[messages.length - 1] : null;
    peers.set(jid, {
      ...peers.get(jid),
      jid,
      name: peers.get(jid)?.name || latest?.name || jid,
      lastMessageAt: latest?.timestamp || peers.get(jid)?.lastMessageAt || null,
      source: peers.has(jid) ? peers.get(jid).source : 'message-log',
    });
  }
  return [...peers.values()];
}

function resolvePeer(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('missing WhatsApp peer');
  const direct = normalizeWhatsappJid(raw);
  if (direct) return direct;
  const query = raw.toLowerCase();
  const matches = allKnownPeers().filter((peer) => {
    return [peer.jid, peer.name, peer.notify, peer.verifiedName, peer.subject]
      .filter(Boolean)
      .some((candidate) => String(candidate).toLowerCase().includes(query));
  });
  if (matches.length === 1) return matches[0].jid;
  if (matches.length > 1) {
    throw new Error(`ambiguous WhatsApp peer ${raw}: ${matches.slice(0, 6).map((peer) => `${peer.name || peer.jid} <${peer.jid}>`).join(', ')}`);
  }
  throw new Error(`unknown WhatsApp peer ${raw}; use a phone number, JID, or run anya whatsapp contacts`);
}

function compactMessage(message) {
  const remoteJid = message?.key?.remoteJid;
  if (!remoteJid) return null;
  const fromMe = Boolean(message?.key?.fromMe);
  const text = extractText(message);
  const timestamp = Number(message?.messageTimestamp || 0) || Math.floor(Date.now() / 1000);
  const quoted = quotedMessageReference(message);
  const media = mediaInfo(message);
  const entry = {
    id: message?.key?.id || null,
    jid: remoteJid,
    name: displayNameForJid(remoteJid),
    fromMe,
    participant: message?.key?.participant || null,
    timestamp,
    text,
    hasMedia: Boolean(media),
  };
  if (media?.kind) entry.mediaKind = media.kind;
  if (quoted?.messageId) {
    entry.quotedMessageId = quoted.messageId;
    entry.quotedChat = quoted.chat;
    entry.quotedParticipant = quoted.participant;
  }
  return entry;
}

function recordMessage(message) {
  const entry = compactMessage(message);
  if (!entry) return null;
  rememberChat(entry.jid, { name: entry.name, lastMessageAt: entry.timestamp });
  const list = Array.isArray(messageLog[entry.jid]) ? messageLog[entry.jid] : [];
  if (entry.id && list.some((existing) => existing.id === entry.id)) return entry.jid;
  list.push(entry);
  messageLog[entry.jid] = list.slice(-100);
  saveMessageLog();
  return entry.jid;
}

function oldestRecordedMessage(jid) {
  const list = Array.isArray(messageLog[jid]) ? messageLog[jid] : [];
  return list.find((entry) => entry?.id && Number.isFinite(Number(entry.timestamp))) || null;
}

function recordedMessages(jid) {
  return Array.isArray(messageLog[jid]) ? messageLog[jid] : [];
}

function findRecordedMessage(jid, messageId) {
  const id = String(messageId || '').trim();
  if (!id) return null;
  return recordedMessages(jid).find((entry) => entry?.id === id) || null;
}

function recordedMessageWindow(jid, messageId, around) {
  const id = String(messageId || '').trim();
  if (!id) return null;
  const messages = recordedMessages(jid);
  const index = messages.findIndex((entry) => entry?.id === id);
  const parsedAround = Number.parseInt(around || 10, 10);
  const radius = Math.max(0, Math.min(Number.isFinite(parsedAround) ? parsedAround : 10, 50));
  if (index === -1) {
    return {
      messageId: id,
      found: false,
      around: radius,
      messages: [],
      detail: 'message id is not in the bridge recorded history for this chat',
    };
  }
  return {
    messageId: id,
    found: true,
    around: radius,
    index,
    messages: messages.slice(Math.max(0, index - radius), index + radius + 1),
  };
}

function waitForHistoryMessages(jid, beforeCount) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve({ received: false, added: 0 });
    }, historySyncWaitMs);
    timeout.unref?.();

    const cleanup = () => {
      clearTimeout(timeout);
      const waiters = pendingHistoryReads.get(jid) || [];
      const next = waiters.filter((waiter) => waiter !== check);
      if (next.length === 0) pendingHistoryReads.delete(jid);
      else pendingHistoryReads.set(jid, next);
    };

    const check = () => {
      const afterCount = Array.isArray(messageLog[jid]) ? messageLog[jid].length : 0;
      if (afterCount <= beforeCount) return;
      cleanup();
      resolve({ received: true, added: afterCount - beforeCount });
    };

    const waiters = pendingHistoryReads.get(jid) || [];
    waiters.push(check);
    pendingHistoryReads.set(jid, waiters);
  });
}

function notifyHistoryMessages(jids) {
  for (const jid of jids) {
    const waiters = pendingHistoryReads.get(jid) || [];
    for (const waiter of waiters) waiter();
  }
}

async function syncChatHistory(sock, jid, requestedCount) {
  const existing = Array.isArray(messageLog[jid]) ? messageLog[jid] : [];
  const anchor = oldestRecordedMessage(jid);
  if (!anchor) {
    return {
      attempted: false,
      reason: 'no_anchor_message',
      detail: 'WhatsApp on-demand history requires at least one recorded message in that chat. Re-link the bridge with full history enabled or wait until a message from this chat is observed.',
    };
  }

  const count = Math.max(1, Math.min(Number.parseInt(requestedCount || 20, 10) || 20, 50));
  const waitForHistory = waitForHistoryMessages(jid, existing.length);
  const requestId = await sock.fetchMessageHistory(
    count,
    {
      remoteJid: jid,
      fromMe: Boolean(anchor.fromMe),
      id: anchor.id,
      participant: anchor.participant || undefined,
    },
    anchor.timestamp
  );
  const result = await waitForHistory;
  return {
    attempted: true,
    requestId,
    anchorId: anchor.id,
    anchorTimestamp: anchor.timestamp,
    ...result,
  };
}

function openTemporaryInbound(jid, seconds) {
  const parsed = Number.parseInt(seconds || 0, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  const expiresAt = Date.now() + parsed * 1000;
  temporaryInboundAllows.set(jid, expiresAt);
  return new Date(expiresAt).toISOString();
}

function hasTemporaryInboundAllow(remoteJid) {
  const expiresAt = temporaryInboundAllows.get(remoteJid);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    temporaryInboundAllows.delete(remoteJid);
    return false;
  }
  return true;
}

function appendMessageLog(jid, entry) {
  const list = Array.isArray(messageLog[jid]) ? messageLog[jid] : [];
  list.push(entry);
  messageLog[jid] = list.slice(-100);
  saveMessageLog();
}

function normalizeOutboundMediaKind(value) {
  const kind = String(value || 'auto').trim().toLowerCase();
  if (['auto', 'document', 'image', 'video', 'audio', 'voice'].includes(kind)) return kind;
  throw new Error(`invalid outbound media kind: ${value}`);
}

function outboundMimeTypeForPath(path) {
  const extension = extname(path).toLowerCase();
  const known = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.m4v': 'video/mp4',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.wav': 'audio/wav',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.zip': 'application/zip',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.doc': 'application/msword',
    '.xls': 'application/vnd.ms-excel',
    '.ppt': 'application/vnd.ms-powerpoint',
  };
  return known[extension] || 'application/octet-stream';
}

function inferOutboundMediaKind(path, requestedKind, mimeType) {
  const kind = normalizeOutboundMediaKind(requestedKind);
  if (kind !== 'auto') return kind;
  const mime = String(mimeType || outboundMimeTypeForPath(path)).toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

function validateOutboundAttachment(attachment) {
  const path = String(attachment?.path || '').trim();
  if (!path) throw new Error('attachment path must not be empty');
  let stat;
  try {
    stat = statSync(path);
    accessSync(path, fsConstants.R_OK);
  } catch (error) {
    throw new Error(`cannot read attachment ${path}: ${error?.message || error}`);
  }
  if (!stat.isFile()) throw new Error(`attachment is not a regular file: ${path}`);
  if (stat.size > maxMediaBytes) {
    throw new Error(
      `attachment ${path} exceeds ${Math.round(maxMediaBytes / 1024 / 1024)} MiB`
    );
  }
  const mimeType = outboundMimeTypeForPath(path);
  const mediaKind = inferOutboundMediaKind(path, attachment?.mediaKind, mimeType);
  return {
    path,
    mediaKind,
    mimeType,
    fileName: safeFileStem(basename(path)) || 'file',
    sizeBytes: stat.size,
  };
}

function mediaKindSupportsCaption(mediaKind) {
  return ['document', 'image', 'video'].includes(mediaKind);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactError(error) {
  const message = error?.message || String(error);
  return message.replace(/\s+/g, ' ').slice(0, 180);
}

function isConnectionClosedError(error) {
  const statusCode = error?.output?.statusCode || error?.statusCode;
  const message = error?.message || String(error);
  return (
    statusCode === DisconnectReason.connectionClosed ||
    statusCode === 428 ||
    /connection closed/i.test(message)
  );
}

function bridgeNoticeText(error) {
  return `Anya WhatsApp bridge lost its connection while sending a reply and reconnected. If the previous reply is missing, send the message again or /status. (${compactError(error)})`;
}

function queueBridgeNotice(jid, text) {
  if (!jid || !text) return;
  const list = Array.isArray(bridgeNotices[jid]) ? bridgeNotices[jid] : [];
  if (!list.some((notice) => notice.text === text)) {
    list.push({
      text,
      timestamp: Math.floor(Date.now() / 1000),
    });
  }
  bridgeNotices[jid] = list.slice(-5);
  saveBridgeNotices();
}

function jidFromChannel(channel) {
  const prefix = `${channelPrefix}:`;
  return String(channel || '').startsWith(prefix) ? channel.slice(prefix.length) : null;
}

function queueBridgeNoticesForActiveRuns(error) {
  for (const channel of activeRuns.keys()) {
    queueBridgeNotice(jidFromChannel(channel), bridgeNoticeText(error));
  }
}

async function waitForCurrentSock(previousSock, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (currentSock && currentSock !== previousSock) return currentSock;
    await sleep(100);
  }
  return currentSock || previousSock;
}

async function sendMessageWithRetry(sock, jid, content, options, retryOptions = {}) {
  const required = retryOptions.required !== false;
  const queueNotice = retryOptions.queueNotice !== false;
  let candidate = currentSock || sock;
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await candidate.sendMessage(jid, content, options);
    } catch (error) {
      lastError = error;
      if (!isConnectionClosedError(error)) break;
      console.error(`Anya WhatsApp send connection error: ${error?.stack || error?.message || error}`);
      candidate = await waitForCurrentSock(candidate, sendRetryMs);
      await sleep(sendRetryMs);
    }
  }
  if (queueNotice) queueBridgeNotice(jid, bridgeNoticeText(lastError));
  if (required) throw lastError;
  return null;
}

async function drainBridgeNotices(sock) {
  const nextNotices = {};
  for (const [jid, notices] of Object.entries(bridgeNotices)) {
    if (!Array.isArray(notices) || notices.length === 0) continue;
    for (const notice of notices) {
      try {
        await sock.sendMessage(jid, { text: notice.text });
      } catch (error) {
        console.error(`Anya WhatsApp notice send failed: ${error?.stack || error?.message || error}`);
        nextNotices[jid] = notices.slice(notices.indexOf(notice));
        break;
      }
    }
  }
  bridgeNotices = nextNotices;
  saveBridgeNotices();
}

async function sendOutboundAttachment(sock, jid, attachment, caption) {
  const content = (() => {
    switch (attachment.mediaKind) {
      case 'image':
        return {
          image: { url: attachment.path },
          mimetype: attachment.mimeType,
          ...(caption ? { caption } : {}),
        };
      case 'video':
        return {
          video: { url: attachment.path },
          mimetype: attachment.mimeType,
          ...(caption ? { caption } : {}),
        };
      case 'audio':
        return {
          audio: { url: attachment.path },
          mimetype: attachment.mimeType,
        };
      case 'voice':
        return {
          audio: { url: attachment.path },
          mimetype: attachment.mimeType,
          ptt: true,
        };
      case 'document':
        return {
          document: { url: attachment.path },
          mimetype: attachment.mimeType,
          fileName: attachment.fileName,
          ...(caption ? { caption } : {}),
        };
      default:
        throw new Error(`unsupported outbound media kind: ${attachment.mediaKind}`);
    }
  })();
  return sendMessageWithRetry(sock, jid, content, undefined, { required: true });
}

function outboundLogBase(jid, result, text) {
  return {
    id: result?.key?.id || null,
    jid,
    name: displayNameForJid(jid),
    fromMe: true,
    participant: null,
    timestamp: Math.floor(Date.now() / 1000),
    text,
  };
}

async function sendOutboundText(sock, jid, text) {
  const result = await sendMessageWithRetry(sock, jid, { text }, undefined, { required: true });
  const entry = {
    ...outboundLogBase(jid, result, text),
    hasMedia: false,
  };
  appendMessageLog(jid, entry);
  return entry;
}

async function sendOutboundMessage(sock, to, text, listenSecs = 0, attachments = []) {
  const jid = resolvePeer(to);
  const captionText = String(text || '').trim();
  const outboundAttachments = (attachments || []).map(validateOutboundAttachment);
  if (!captionText && outboundAttachments.length === 0) {
    throw new Error('message text or attachment must not be empty');
  }
  rememberChat(jid, { lastMessageAt: Math.floor(Date.now() / 1000) });
  const entries = [];
  if (outboundAttachments.length === 0) {
    entries.push(await sendOutboundText(sock, jid, captionText));
  } else {
    let captionConsumed = false;
    if (captionText && !mediaKindSupportsCaption(outboundAttachments[0].mediaKind)) {
      entries.push(await sendOutboundText(sock, jid, captionText));
      captionConsumed = true;
    }
    for (const [index, attachment] of outboundAttachments.entries()) {
      const caption =
        index === 0 && captionText && !captionConsumed && mediaKindSupportsCaption(attachment.mediaKind)
          ? captionText
          : '';
      const result = await sendOutboundAttachment(sock, jid, attachment, caption);
      const entry = {
        ...outboundLogBase(jid, result, caption),
        hasMedia: true,
        mediaKind: attachment.mediaKind,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        path: attachment.path,
      };
      appendMessageLog(jid, entry);
      entries.push(entry);
      if (caption) captionConsumed = true;
    }
  }
  const listeningUntil = openTemporaryInbound(jid, listenSecs);
  return {
    jid,
    messageId: entries[0]?.id || null,
    messageIds: entries.map((entry) => entry.id).filter(Boolean),
    attachments: outboundAttachments,
    listeningUntil,
  };
}

async function readRecordedMessages(sock, chat, limit, messageId = null, around = 10) {
  const jid = resolvePeer(chat);
  const count = Math.max(1, Math.min(Number.parseInt(limit || 20, 10) || 20, 100));
  const sync = await syncChatHistory(sock, jid, count);
  if (messageId) {
    const window = recordedMessageWindow(jid, messageId, around);
    return {
      jid,
      sync,
      match: window,
      messages: window?.found ? window.messages : recordedMessages(jid).slice(-count),
    };
  }
  return {
    jid,
    sync,
    messages: recordedMessages(jid).slice(-count),
  };
}

function listKnownContacts(query) {
  const normalized = String(query || '').trim().toLowerCase();
  return allKnownPeers()
    .filter((peer) => {
      if (!normalized) return true;
      return [peer.jid, peer.name, peer.notify, peer.verifiedName, peer.subject]
        .filter(Boolean)
        .some((candidate) => String(candidate).toLowerCase().includes(normalized));
    })
    .slice(0, 100);
}

async function createChannelSession(remoteJid) {
  const channel = channelName(remoteJid);
  await runAnya(['session-create', '--endpoint', endpoint, '--channel', channel], {
    timeoutMs: commandTimeoutMs,
  });
  return channel;
}

async function ensureChannel(remoteJid) {
  const channel = channelName(remoteJid);
  try {
    const resolved = await runAnya(['channel', 'resolve', channel], {
      timeoutMs: commandTimeoutMs,
    });
    if (resolved.trim()) return channel;
  } catch {
  }
  await createChannelSession(remoteJid);
  return channel;
}

function extractText(message) {
  const m = messagePayload(message);
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ''
  ).trim();
}

function messagePayload(message) {
  let payload = message?.message;
  for (let i = 0; i < 4; i += 1) {
    if (payload?.ephemeralMessage?.message) {
      payload = payload.ephemeralMessage.message;
    } else if (payload?.viewOnceMessage?.message) {
      payload = payload.viewOnceMessage.message;
    } else if (payload?.viewOnceMessageV2?.message) {
      payload = payload.viewOnceMessageV2.message;
    } else if (payload?.documentWithCaptionMessage?.message) {
      payload = payload.documentWithCaptionMessage.message;
    } else {
      break;
    }
  }
  return payload || {};
}

function mediaInfo(message) {
  const payload = messagePayload(message);
  if (payload.imageMessage) {
    return {
      kind: 'image',
      downloadType: 'image',
      content: payload.imageMessage,
      promptLabel: 'image',
      imageInput: true,
    };
  }
  if (payload.videoMessage) {
    return {
      kind: 'video',
      downloadType: 'video',
      content: payload.videoMessage,
      promptLabel: 'video',
      imageInput: false,
    };
  }
  if (payload.audioMessage) {
    return {
      kind: payload.audioMessage.ptt ? 'voice' : 'audio',
      downloadType: 'audio',
      content: payload.audioMessage,
      promptLabel: payload.audioMessage.ptt ? 'voice note' : 'audio',
      imageInput: false,
    };
  }
  if (payload.documentMessage) {
    return {
      kind: 'document',
      downloadType: 'document',
      content: payload.documentMessage,
      promptLabel: payload.documentMessage.fileName
        ? `file ${payload.documentMessage.fileName}`
        : 'file',
      imageInput: false,
    };
  }
  if (payload.stickerMessage) {
    return {
      kind: 'sticker',
      downloadType: 'sticker',
      content: payload.stickerMessage,
      promptLabel: 'sticker',
      imageInput: false,
    };
  }
  return null;
}

function contextInfoForMessage(message) {
  const payload = messagePayload(message);
  return (
    payload.extendedTextMessage?.contextInfo ||
    payload.imageMessage?.contextInfo ||
    payload.videoMessage?.contextInfo ||
    payload.documentMessage?.contextInfo ||
    payload.audioMessage?.contextInfo ||
    payload.stickerMessage?.contextInfo ||
    null
  );
}

function quotedMessageReference(message) {
  const contextInfo = contextInfoForMessage(message);
  if (!contextInfo?.stanzaId && !contextInfo?.quotedMessage) return null;
  return {
    chat: contextInfo.remoteJid || message?.key?.remoteJid || null,
    messageId: contextInfo.stanzaId || null,
    participant: contextInfo.participant || null,
    quotedMessage: contextInfo.quotedMessage || null,
  };
}

function truncateForPrompt(value, maxLength = 1200) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function quotedMessageContext(message) {
  const reference = quotedMessageReference(message);
  if (!reference) return null;
  const quotedMessage = reference.quotedMessage
    ? {
        key: {
          remoteJid: reference.chat,
          id: reference.messageId,
          participant: reference.participant || undefined,
        },
        message: reference.quotedMessage,
      }
    : null;
  const embeddedText = quotedMessage ? extractText(quotedMessage) : '';
  const embeddedMedia = quotedMessage ? mediaInfo(quotedMessage) : null;
  const recorded = reference.chat && reference.messageId
    ? findRecordedMessage(reference.chat, reference.messageId)
    : null;
  return {
    ...reference,
    embedded: Boolean(reference.quotedMessage),
    text: embeddedText || recorded?.text || '',
    mediaKind: embeddedMedia?.kind || recorded?.mediaKind || (recorded?.hasMedia ? 'media' : null),
    recorded: Boolean(recorded),
    fromMe: recorded?.fromMe ?? null,
    timestamp: recorded?.timestamp ?? null,
  };
}

function safeFileStem(value) {
  return String(value || '')
    .trim()
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function extensionForMime(mimeType, kind) {
  const mime = String(mimeType || '').split(';')[0].trim().toLowerCase();
  const known = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/wav': 'wav',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'text/csv': 'csv',
    'application/json': 'json',
    'application/zip': 'zip',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/msword': 'doc',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.ms-powerpoint': 'ppt',
  };
  if (known[mime]) return known[mime];
  if (kind === 'image') return 'img';
  if (kind === 'video') return 'video';
  if (kind === 'audio' || kind === 'voice') return 'audio';
  if (kind === 'sticker') return 'webp';
  return 'file';
}

async function downloadMediaAttachment(message) {
  const info = mediaInfo(message);
  if (!info) return null;
  const stream = await downloadContentFromMessage(info.content, info.downloadType);
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of stream) {
    totalBytes += chunk.length;
    if (totalBytes > maxMediaBytes) {
      throw new Error(
        `WhatsApp ${info.promptLabel} exceeds ${Math.round(maxMediaBytes / 1024 / 1024)} MiB`
      );
    }
    chunks.push(chunk);
  }
  const mimeType = info.content?.mimetype || 'application/octet-stream';
  const extension = extensionForMime(mimeType, info.kind);
  const originalName = info.content?.fileName ? safeFileStem(info.content.fileName) : '';
  const uniquePrefix = `${Date.now()}-${randomUUID()}`;
  const displayName = originalName || `${info.kind}.${extension}`;
  const fileName = displayName.includes('.')
    ? `${uniquePrefix}-${displayName}`
    : `${uniquePrefix}-${displayName}.${extension}`;
  const path = join(mediaDir, fileName);
  writeFileSync(path, Buffer.concat(chunks));
  return {
    ...info,
    mimeType,
    path,
    sizeBytes: totalBytes,
  };
}

let transcriberSetup;

async function ensureTranscriber() {
  const python = join(transcriberVenv, 'bin', 'python');
  if (existsSync(python)) return python;
  if (!transcriberSetup) {
    transcriberSetup = (async () => {
      await runProcess('python3', ['-m', 'venv', transcriberVenv], {
        timeoutMs: transcribeTimeoutMs,
      });
      const pip = join(transcriberVenv, 'bin', 'pip');
      await runProcess(pip, ['install', '--quiet', '--upgrade', 'pip'], {
        timeoutMs: transcribeTimeoutMs,
      });
      await runProcess(pip, ['install', '--quiet', 'faster-whisper'], {
        timeoutMs: transcribeTimeoutMs,
      });
      return python;
    })();
  }
  return transcriberSetup;
}

async function transcribeAudioAttachment(attachment) {
  if (!transcribeAudio || !attachment || !['audio', 'voice'].includes(attachment.kind)) {
    return attachment;
  }
  try {
    const python = await ensureTranscriber();
    const script = `
from faster_whisper import WhisperModel
import sys

path = sys.argv[1]
model_name = sys.argv[2]
model = WhisperModel(model_name, device="cpu", compute_type="int8")
segments, info = model.transcribe(path, beam_size=5, vad_filter=True)
text = " ".join(segment.text.strip() for segment in segments).strip()
print(text)
`;
    const transcript = (await runProcess(python, ['-c', script, attachment.path, transcribeModel], {
      timeoutMs: transcribeTimeoutMs,
    })).trim();
    if (transcript) {
      return {
        ...attachment,
        transcript,
      };
    }
  } catch (error) {
    console.error(`Anya WhatsApp audio transcription error: ${error?.stack || error?.message || error}`);
    return {
      ...attachment,
      transcriptionError: error?.message || String(error),
    };
  }
  return attachment;
}

function promptWithMedia(text, attachment) {
  if (!attachment) return text;
  if (attachment.transcript) {
    const lines = [];
    if (text) lines.push(text, '');
    lines.push(`WhatsApp ${attachment.promptLabel} transcription:`, attachment.transcript);
    lines.push(
      '',
      `Source ${attachment.promptLabel} file, only if needed: ${attachment.path} (${attachment.mimeType}, ${attachment.sizeBytes} bytes).`
    );
    return lines.join('\n').trim();
  }

  const lines = [];
  if (text) {
    lines.push(text);
  } else {
    lines.push(`Please inspect this WhatsApp ${attachment.promptLabel}.`);
  }
  lines.push('', 'WhatsApp attachments:');
  const asImage = attachment.imageInput ? ' Attached as an image input.' : '';
  lines.push(
    `- ${attachment.promptLabel}: ${attachment.path} (${attachment.mimeType}, ${attachment.sizeBytes} bytes).${asImage}`
  );
  if (!attachment.imageInput) {
    if (attachment.transcriptionError) {
      lines.push(`Auto-transcription failed: ${attachment.transcriptionError}`);
    }
    lines.push('Use local shell tools on the saved file if you need to inspect, transcribe, summarize, convert, or parse it.');
  }
  return lines.join('\n').trim();
}

function promptWithQuotedMessageContext(text, quote) {
  if (!quote) return text;
  const lines = [];
  if (text) lines.push(text, '');
  lines.push('WhatsApp reply context:');
  if (quote.messageId) {
    lines.push(`- User replied to WhatsApp message id: ${quote.messageId}`);
  } else {
    lines.push('- User replied to a WhatsApp message with no message id in the event.');
  }
  if (quote.chat) lines.push(`- Quoted chat: ${quote.chat}`);
  if (quote.participant) lines.push(`- Quoted participant: ${quote.participant}`);
  if (quote.timestamp) lines.push(`- Recorded quoted timestamp: ${quote.timestamp}`);
  if (quote.fromMe !== null) lines.push(`- Recorded quoted fromMe: ${quote.fromMe}`);
  if (quote.embedded) {
    lines.push('- Quoted payload was embedded in this WhatsApp event.');
  } else {
    lines.push('- Quoted payload was not embedded in this WhatsApp event; it may be old or unavailable from WhatsApp.');
  }
  if (quote.text) lines.push(`- Quoted text: ${truncateForPrompt(quote.text)}`);
  if (quote.mediaKind) lines.push(`- Quoted media kind: ${quote.mediaKind}`);
  if (quote.recorded) lines.push('- Quoted message was found in Anya recorded WhatsApp history.');
  if (quote.chat && quote.messageId) {
    lines.push(
      `- To fetch recorded/synced messages around it, run: anya whatsapp read --chat "${quote.chat}" --message-id "${quote.messageId}" --around 10`
    );
  }
  return lines.join('\n').trim();
}

function isGroup(remoteJid) {
  return remoteJid.endsWith('@g.us');
}

function normalizeAccessId(value) {
  return String(value || '')
    .trim()
    .replace(/^whatsapp:/i, '')
    .replace(/^\+/, '')
    .toLowerCase();
}

function accessIdsForMessage(message, remoteJid) {
  const ids = new Set();
  for (const value of [remoteJid, message?.key?.participant]) {
    const normalized = normalizeAccessId(value);
    if (!normalized) continue;
    ids.add(normalized);
    const bare = normalized.split('@')[0];
    if (bare) ids.add(bare);
    const digits = bare.replace(/\D/g, '');
    if (digits) ids.add(digits);
  }
  return ids;
}

function listMatches(ids, list) {
  return list.some((entry) => {
    const normalized = normalizeAccessId(entry);
    if (normalized === '*') return true;
    if (ids.has(normalized)) return true;
    const bare = normalized.split('@')[0];
    if (bare && ids.has(bare)) return true;
    const digits = bare.replace(/\D/g, '');
    return Boolean(digits && ids.has(digits));
  });
}

function isAllowedInbound(message, remoteJid) {
  if (hasTemporaryInboundAllow(remoteJid)) {
    return { allowed: true, reason: 'temporary outbound listen window' };
  }
  const ids = accessIdsForMessage(message, remoteJid);
  if (listMatches(ids, blockFrom)) {
    return { allowed: false, reason: 'sender blocked by blockFrom' };
  }

  if (isGroup(remoteJid)) {
    if (groupPolicy === 'disabled') {
      return { allowed: false, reason: 'groupPolicy=disabled' };
    }
    const groupIds = new Set([normalizeAccessId(remoteJid)]);
    if (allowedGroups.length > 0 && !listMatches(groupIds, allowedGroups)) {
      return { allowed: false, reason: 'group not listed in groups' };
    }
    const groupAllowList = groupAllowFrom.length > 0 ? groupAllowFrom : allowFrom;
    if (groupPolicy === 'allowlist' && !listMatches(ids, groupAllowList)) {
      return { allowed: false, reason: 'sender not in group allowlist' };
    }
    return { allowed: true, reason: 'group allowed' };
  }

  if (dmPolicy === 'disabled') {
    return { allowed: false, reason: 'dmPolicy=disabled' };
  }
  if (dmPolicy === 'allowlist' && !listMatches(ids, allowFrom)) {
    return { allowed: false, reason: 'sender not in allowFrom' };
  }
  return { allowed: true, reason: 'dm allowed' };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentionedBot(message, sock) {
  const payload = messagePayload(message);
  const mentions = [
    ...(payload.extendedTextMessage?.contextInfo?.mentionedJid || []),
    ...(payload.imageMessage?.contextInfo?.mentionedJid || []),
    ...(payload.videoMessage?.contextInfo?.mentionedJid || []),
    ...(payload.documentMessage?.contextInfo?.mentionedJid || []),
    ...(payload.audioMessage?.contextInfo?.mentionedJid || []),
  ];
  const own = sock.user?.id?.split(':')[0];
  return own ? mentions.some((jid) => jid.includes(own)) : false;
}

function stripInvocation(text, message, sock) {
  const trimmed = text.trim();
  const escapedBotName = escapeRegex(botName);
  const patterns = [
    new RegExp(`^@?${escapedBotName}(?:[,:\\s]+|$)`, 'i'),
    /^\/anya(?:@\S+)?\s+/i,
    /^\/ask(?:@\S+)?\s+/i,
  ];
  for (const pattern of patterns) {
    if (pattern.test(trimmed)) return trimmed.replace(pattern, '').trim();
  }
  if (mentionedBot(message, sock)) return trimmed.replace(/^@\S+\s*/, '').trim();
  return trimmed;
}

function shouldRespond(text, remoteJid, message, sock, hasAttachment = false) {
  if (!text && !hasAttachment) return false;
  if (!isGroup(remoteJid)) return true;
  if (!requireMention) return true;
  const lower = text.toLowerCase();
  return (
    lower === botName ||
    lower.startsWith(`${botName} `) ||
    lower.startsWith(`${botName},`) ||
    lower.startsWith(`${botName}:`) ||
    lower.startsWith('/anya') ||
    lower.startsWith('/ask') ||
    mentionedBot(message, sock)
  );
}

function parseSlashCommand(text) {
  const match = text.trim().match(/^\/([a-zA-Z0-9_-]+)(?:@\S+)?(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return {
    name: match[1].toLowerCase(),
    rest: (match[2] || '').trim(),
  };
}

function isChannelSlashCommand(command) {
  return ['new', 'reset', 'stop', 'status', 'auth', 'login', 'update', 'restart', 'help', 'reply', 'models', 'model', 'effort', 'thinking', 'fast', 'service-tier', 'settings'].includes(command?.name);
}

function stopActiveRun(channel) {
  const active = activeRuns.get(channel);
  if (!active) return false;
  active.stop();
  return true;
}

function formatAnyaError(error) {
  const message = error?.message || String(error);
  if (
    message.includes('token_invalidated') ||
    message.includes('refresh_token') ||
    message.includes('401 Unauthorized') ||
    message.includes('Unauthorized')
  ) {
    return 'Anya needs a fresh Codex login. Send /login in this WhatsApp chat.';
  }
  if (message.includes('timed out')) {
    return 'Anya timed out waiting for Codex. Send /auth to check the live auth state.';
  }
  if (message.includes('auth probe returned unexpected reply')) {
    return 'Anya auth exists, but Codex did not return a usable reply. Send /login to refresh auth.';
  }
  if (message.includes('failed to load configuration') || message.includes('Model provider')) {
    return `Anya configuration error: ${message}`;
  }
  return `Anya error: ${message}`;
}

function isAuthFailure(error) {
  const message = error?.message || String(error);
  return (
    message.includes('token_invalidated') ||
    message.includes('refresh_token') ||
    message.includes('401 Unauthorized') ||
    message.includes('Unauthorized') ||
    message.includes('auth probe returned unexpected reply')
  );
}

function rememberAuthFailure(error) {
  if (!isAuthFailure(error)) return;
  authPreflight.okUntil = 0;
  authPreflight.failure = error;
  authPreflight.failureUntil = Date.now() + authPreflightFailureTtlMs;
}

async function ensureCodexAuthReady() {
  const now = Date.now();
  if (authPreflight.okUntil > now) return;
  if (authPreflight.failure && authPreflight.failureUntil > now) {
    throw authPreflight.failure;
  }
  if (authPreflight.pending) return authPreflight.pending;

  authPreflight.pending = runAnya([
    'auth',
    'status',
    '--endpoint',
    endpoint,
    '--timeout-secs',
    String(Math.max(1, Math.ceil(authPreflightTimeoutMs / 1000))),
  ], {
    timeoutMs: authPreflightTimeoutMs + 5_000,
  }).then(() => {
    authPreflight.okUntil = Date.now() + authPreflightTtlMs;
    authPreflight.failureUntil = 0;
    authPreflight.failure = null;
  }).catch((error) => {
    rememberAuthFailure(error);
    throw error;
  }).finally(() => {
    authPreflight.pending = null;
  });

  return authPreflight.pending;
}

function isStoppedError(error) {
  return error?.name === 'AnyaRunStoppedError';
}

function isThreadNotFoundError(error) {
  const message = error?.message || String(error);
  return message.includes('thread not found');
}

async function replyText(sock, remoteJid, message, text, options = {}) {
  const sendOptions = options.quoted ? { quoted: message } : undefined;
  await sendMessageWithRetry(sock, remoteJid, { text }, sendOptions, { required: false });
}

function stripTerminalFormatting(text) {
  return String(text || '')
    .replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

function redactDeviceLoginOutput(text) {
  return stripTerminalFormatting(text)
    .replace(/\b[A-Z0-9]{4}[-\s][A-Z0-9]{4,8}\b/g, '<device-code>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function deviceLoginPromptFromOutput(output) {
  const clean = stripTerminalFormatting(output);
  const url = clean.match(/https:\/\/auth\.openai\.com\/codex\/device\b/)?.[0];
  const code = clean.match(/\b[A-Z0-9]{4}[-\s][A-Z0-9]{4,8}\b/)?.[0]?.replace(/\s+/, '-');
  if (!url || !code) return null;
  return { url, code };
}

async function sendDeviceLoginPrompt(sock, remoteJid, message, prompt) {
  await replyText(sock, remoteJid, message, 'Anya needs a fresh Codex login. Open this URL:');
  await replyText(sock, remoteJid, message, prompt.url);
  await replyText(sock, remoteJid, message, 'Enter this code:');
  await replyText(sock, remoteJid, message, prompt.code);
  await replyText(sock, remoteJid, message, 'I will wait here and restart the service after login succeeds.');
}

function scheduleServiceRestart() {
  const unit = `anya-self-restart-${Date.now()}`;
  const child = spawn('systemd-run', [
    '--user',
    `--unit=${unit}`,
    '--on-active=2s',
    'systemctl',
    '--user',
    'restart',
    'anya.service',
  ], {
    stdio: 'ignore',
  });
  let fallbackStarted = false;
  const fallback = () => {
    if (fallbackStarted) return;
    fallbackStarted = true;
    const fallback = spawn('sh', [
      '-lc',
      '(sleep 2; systemctl --user restart anya.service) >/dev/null 2>&1 &',
    ], {
      detached: true,
      stdio: 'ignore',
    });
    fallback.unref?.();
  };
  child.on('error', fallback);
  child.on('close', (code) => {
    if (code !== 0) fallback();
  });
  child.unref?.();
}

async function runDeviceLoginFromWhatsapp(sock, remoteJid, message) {
  if (activeDeviceLogin) {
    await replyText(sock, remoteJid, message, 'A device login is already in progress.');
    return;
  }

  activeDeviceLogin = true;
  await replyText(sock, remoteJid, message, 'Starting Anya device login...');

  let output = '';
  let sentPrompt = false;
  let promptTimer;
  let promptSend = Promise.resolve();
  const maybeSendPrompt = () => {
    if (sentPrompt) return;
    const prompt = deviceLoginPromptFromOutput(output);
    if (!prompt) return;
    clearTimeout(promptTimer);
    sentPrompt = true;
    promptSend = sendDeviceLoginPrompt(sock, remoteJid, message, prompt).catch((error) => {
      console.error(`Anya WhatsApp login prompt send failed: ${error?.stack || error?.message || error}`);
    });
  };

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(anyaBinary, ['login', '--device-auth'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let settled = false;
      let sentSignal = false;
      let killTimer;
      const stopChild = () => {
        if (child.exitCode !== null || sentSignal) return;
        child.kill('SIGTERM');
        sentSignal = true;
        killTimer = setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
        }, 2_000);
        killTimer.unref?.();
      };
      const timeout = setTimeout(() => {
        stopChild();
        if (!settled) {
          settled = true;
          reject(new Error('Device login timed out. Send /login to try again.'));
        }
      }, deviceLoginTimeoutMs);
      timeout.unref?.();
      promptTimer = setTimeout(() => {
        if (sentPrompt || settled) return;
        console.error(`Anya WhatsApp login prompt parse failed for ${anyaBinary}: ${redactDeviceLoginOutput(output) || '<no output>'}`);
        stopChild();
        settled = true;
        clearTimeout(timeout);
        reject(new Error('Device login started, but Anya could not read the OpenAI device URL and code from Codex output. I stopped the login attempt instead of hanging; send /login again after Anya is updated.'));
      }, deviceLoginPromptTimeoutMs);
      promptTimer.unref?.();

      const onData = (chunk) => {
        output += String(chunk);
        if (output.length > 128 * 1024) {
          output = output.slice(-128 * 1024);
        }
        maybeSendPrompt();
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(promptTimer);
        clearTimeout(killTimer);
        reject(error);
      });
      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(promptTimer);
        clearTimeout(killTimer);
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(output.trim() || `anya login exited with ${code ?? signal}`));
      });
    });
    await promptSend;
    await replyText(sock, remoteJid, message, 'Anya login succeeded. Restarting the service now; retry your message in a few seconds.');
    scheduleServiceRestart();
  } catch (error) {
    await promptSend;
    await replyText(sock, remoteJid, message, formatAnyaError(error));
  } finally {
    activeDeviceLogin = false;
  }
}

function updateErrorMessage(error) {
  const message = error?.message || String(error);
  if (message.includes('timed out')) {
    return `Anya update did not finish within ${Math.round(updateTimeoutMs / 1000)}s, so I stopped that updater process. Send /update again later or check the service logs.`;
  }
  return `Anya update failed: ${message}`;
}

async function runUpdateFromWhatsapp(sock, remoteJid, message) {
  if (activeUpdate) {
    await replyText(sock, remoteJid, message, 'An Anya update is already running.');
    return;
  }

  activeUpdate = true;
  const channel = channelName(remoteJid);
  await replyText(
    sock,
    remoteJid,
    message,
    'Starting Anya update from the GitHub release. I will send a confirmation here after the service restarts.'
  );

  try {
    const output = await runAnya([
      'update',
      '--notify-channel',
      channel,
      '--notify-message',
      'Anya update completed and the service is back online.',
    ], {
      timeoutMs: updateTimeoutMs,
    });
    const summary = output
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-6)
      .join('\n');
    await replyText(
      sock,
      remoteJid,
      message,
      summary ? `Anya update command finished:\n${summary}` : 'Anya update command finished.'
    );
  } catch (error) {
    await replyText(sock, remoteJid, message, updateErrorMessage(error));
  } finally {
    activeUpdate = false;
  }
}

function lastRegexEnd(text, regex) {
  regex.lastIndex = 0;
  let end = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    end = match.index + match[0].length;
  }
  return end;
}

function strongChunkEnd(text) {
  return Math.max(
    lastRegexEnd(text, /\n\s*\n/g),
    lastRegexEnd(text, /```[\s\S]*?```\s*/g)
  );
}

function naturalChunkEnd(text) {
  return Math.max(
    lastRegexEnd(text, /\n\s*\n/g),
    lastRegexEnd(text, /(?<!\d)[.!?]["')\]]?(?:\s+|$)/g),
    lastRegexEnd(text, /\n+/g)
  );
}

function wordBoundaryEnd(text, limit) {
  const capped = Math.min(limit, text.length);
  for (let index = capped; index > 0; index -= 1) {
    if (/\s/.test(text[index - 1])) return index;
  }
  return capped;
}

function promptWithWhatsappContext(remoteJid, text) {
  const displayName = displayNameForJid(remoteJid);
  return [
    `WhatsApp chat context: current chat JID is ${remoteJid}; display name is ${displayName}.`,
    `To send a file or media item back to this exact chat, run: anya whatsapp send --to "${remoteJid}" --file "/path/to/file" "optional caption".`,
    'Use --media-kind document|image|video|audio|voice only when auto-detection is wrong. Confirm before sending sensitive files or sending files to a third party.',
    '',
    text,
  ].join('\n').trim();
}

async function streamPrompt(sock, remoteJid, message, channel, text, options = {}) {
  let buffer = '';
  let flushTimer;
  let activeMessageItemId = null;
  let sendQueue = Promise.resolve();
  const quoted = Boolean(options.quoted);
  const images = options.images || [];
  const settings = {
    ...settingsForChannel(channel),
    ...(options.settings || {}),
  };

  const enqueue = (fn) => {
    sendQueue = sendQueue.then(fn, fn);
    return sendQueue;
  };
  const sendPresence = () => {
    void sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});
  };
  const nextFlushChunk = (force = false) => {
    if (!buffer.trim()) {
      buffer = '';
      return null;
    }
    let end = force ? naturalChunkEnd(buffer) : strongChunkEnd(buffer);
    if (end <= 0 && buffer.length >= streamFlushChars) {
      end = force
        ? naturalChunkEnd(buffer.slice(0, streamFlushChars))
        : strongChunkEnd(buffer.slice(0, streamFlushChars));
      if (end <= 0) end = wordBoundaryEnd(buffer, streamFlushChars);
    }
    if (end <= 0 && force) end = buffer.length;
    if (end <= 0) return null;

    const chunk = buffer.slice(0, end).trim();
    buffer = buffer.slice(end).replace(/^\s+/, '');
    return chunk || null;
  };
  const flush = (force = false) => {
    clearTimeout(flushTimer);
    flushTimer = undefined;
    while (true) {
      const chunk = nextFlushChunk(force);
      if (!chunk) return;
      enqueue(() => replyText(sock, remoteJid, message, chunk, { quoted }));
    }
  };
  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => flush(false), streamFlushMs);
    flushTimer.unref?.();
  };

  await ensureCodexAuthReady();
  sendPresence();
  const presenceInterval = setInterval(sendPresence, 15_000);
  presenceInterval.unref?.();
  try {
    const args = [
      'session-send',
      '--endpoint',
      endpoint,
      '--channel',
      channel,
      '--stream-json',
    ];
    for (const image of images) {
      args.push('--image', image);
    }
    if (settings.model) args.push('--model', settings.model);
    if (settings.effort) args.push('--effort', settings.effort);
    if (settings.serviceTier) args.push('--service-tier', settings.serviceTier);
    args.push(promptWithWhatsappContext(remoteJid, text));
    await streamAnya(args, {
      onMessageDelta: (delta, event) => {
        if (!delta) return;
        if (event?.item_id && activeMessageItemId && event.item_id !== activeMessageItemId) {
          flush(true);
        }
        if (event?.item_id) activeMessageItemId = event.item_id;
        buffer += delta;
        if (!streamReplies) return;
        flush(false);
        if (buffer) scheduleFlush();
      },
      onActivity: (event) => {
        if (event?.type === 'turn_accepted' && event.turn_id) {
          const active = activeRuns.get(channel);
          if (active) active.turnId = event.turn_id;
        }
        sendPresence();
      },
    }, {
      activeKey: channel,
      timeoutMs: replyTimeoutMs,
    });
    flush(true);
    await sendQueue;
  } finally {
    clearInterval(presenceInterval);
    clearTimeout(flushTimer);
  }
}

async function streamPromptWithRecovery(sock, remoteJid, message, channel, text, options = {}) {
  try {
    await streamPrompt(sock, remoteJid, message, channel, text, options);
  } catch (error) {
    rememberAuthFailure(error);
    if (!isThreadNotFoundError(error)) throw error;
    await createChannelSession(remoteJid);
    await streamPrompt(sock, remoteJid, message, channel, text, options);
  }
}

async function waitForActiveTurnId(channel, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const active = activeRuns.get(channel);
    if (!active) return null;
    if (active.turnId) return active.turnId;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return activeRuns.get(channel)?.turnId || null;
}

function updateActiveTurnId(channel, turnId) {
  if (!turnId) return;
  const active = activeRuns.get(channel);
  if (active) active.turnId = turnId;
}

function parseTurnSteerResponse(output) {
  try {
    const response = JSON.parse(String(output || '').trim());
    return response?.turnId || response?.turn_id || null;
  } catch {
    return null;
  }
}

function activeTurnIdFromMismatch(error) {
  const message = error?.message || String(error);
  const match = message.match(/but found [`']([^`']+)[`']/);
  return match?.[1] || null;
}

async function runSessionSteer(channel, turnId, text, images) {
  const args = [
    'session-steer',
    '--endpoint',
    endpoint,
    '--channel',
    channel,
    '--turn-id',
    turnId,
  ];
  for (const image of images || []) {
    args.push('--image', image);
  }
  args.push(text);
  const output = await runAnya(args, {
    timeoutMs: commandTimeoutMs,
  });
  updateActiveTurnId(channel, parseTurnSteerResponse(output) || turnId);
}

async function steerActiveRun(sock, remoteJid, message, channel, text, options = {}) {
  const turnId = await waitForActiveTurnId(channel);
  if (!turnId) {
    console.error(`Anya WhatsApp steer skipped: no active turn id for ${channel}`);
    return;
  }
  const prompt = promptWithWhatsappContext(remoteJid, text);
  try {
    await runSessionSteer(channel, turnId, prompt, options.images || []);
  } catch (error) {
    const foundTurnId = activeTurnIdFromMismatch(error);
    if (!foundTurnId || foundTurnId === turnId) throw error;
    console.warn(`Anya WhatsApp steer retrying with active turn id ${foundTurnId}`);
    updateActiveTurnId(channel, foundTurnId);
    await runSessionSteer(channel, foundTurnId, prompt, options.images || []);
  }
}

function steerActiveRunInBackground(sock, remoteJid, message, channel, text, options = {}) {
  void steerActiveRun(sock, remoteJid, message, channel, text, options).catch((error) => {
    rememberAuthFailure(error);
    if (isAuthFailure(error)) {
      stopActiveRun(channel);
      void replyText(sock, remoteJid, message, formatAnyaError(error));
      return;
    }
    console.error(`Anya WhatsApp steer error: ${error?.stack || error?.message || error}`);
  });
}

async function handleSlashCommand(sock, remoteJid, message, command) {
  const channel = channelName(remoteJid);
  switch (command.name) {
    case 'new':
    case 'reset':
      stopActiveRun(channel);
      await createChannelSession(remoteJid);
      if (command.rest) {
        try {
          await streamPrompt(sock, remoteJid, message, channel, command.rest);
        } finally {
          await sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
        }
      } else {
        await replyText(sock, remoteJid, message, 'Started a new Anya session for this channel.');
      }
      return true;
    case 'stop':
      if (stopActiveRun(channel)) {
        await replyText(sock, remoteJid, message, 'Stopped the active Anya reply for this channel.');
      } else {
        await replyText(sock, remoteJid, message, 'No active Anya reply is running for this channel.');
      }
      return true;
    case 'status':
      await replyText(
        sock,
        remoteJid,
        message,
        `Anya is connected. Channel: ${channel}. Active reply: ${activeRuns.has(channel) ? 'yes' : 'no'}. Login flow: ${activeDeviceLogin ? 'running' : 'idle'}. Update flow: ${activeUpdate ? 'running' : 'idle'}. ${describeChannelSettings(channel)} Send /auth to probe Codex auth, /login to refresh it, or /update to update Anya.`
      );
      return true;
    case 'auth':
      try {
        const authOutput = await runAnya([
          'auth',
          'status',
          '--endpoint',
          endpoint,
          '--timeout-secs',
          '20',
        ], {
          timeoutMs: 25_000,
        });
        await replyText(sock, remoteJid, message, authOutput.trim() || 'Auth probe completed with no output.');
      } catch (error) {
        const messageText = (error?.message || String(error)).includes('timed out')
          ? 'Anya auth probe timed out. Send /login to refresh Codex auth, or /restart if login already succeeded.'
          : formatAnyaError(error);
        await replyText(sock, remoteJid, message, messageText);
      }
      return true;
    case 'login':
      await runDeviceLoginFromWhatsapp(sock, remoteJid, message);
      return true;
    case 'update':
      await runUpdateFromWhatsapp(sock, remoteJid, message);
      return true;
    case 'restart':
      await replyText(sock, remoteJid, message, 'Restarting Anya service now; retry in a few seconds.');
      scheduleServiceRestart();
      return true;
    case 'settings':
      await replyText(sock, remoteJid, message, describeChannelSettings(channel));
      return true;
    case 'models': {
      const args = ['models', '--endpoint', endpoint, '--format', 'whatsapp'];
      if (/\bhidden\b/i.test(command.rest)) args.push('--include-hidden');
      const modelList = await runAnya(args, {
        timeoutMs: commandTimeoutMs,
      });
      await replyText(sock, remoteJid, message, modelList.trim());
      return true;
    }
    case 'model': {
      const value = command.rest.trim();
      if (!value) {
        await replyText(
          sock,
          remoteJid,
          message,
          `${describeChannelSettings(channel)} Usage: /model <model-id|default>`
        );
        return true;
      }
      const model = ['default', 'unset', 'clear'].includes(value.toLowerCase()) ? null : value;
      updateChannelSettings(channel, { model });
      await replyText(sock, remoteJid, message, `Updated. ${describeChannelSettings(channel)}`);
      return true;
    }
    case 'effort':
    case 'thinking': {
      const value = command.rest.trim();
      if (!value) {
        await replyText(
          sock,
          remoteJid,
          message,
          `${describeChannelSettings(channel)} Usage: /thinking <none|minimal|low|medium|high|xhigh|default>`
        );
        return true;
      }
      const effort = normalizeReasoningEffort(value);
      updateChannelSettings(channel, { effort });
      await replyText(sock, remoteJid, message, `Updated. ${describeChannelSettings(channel)}`);
      return true;
    }
    case 'fast': {
      const value = command.rest.trim();
      if (!value) {
        await replyText(
          sock,
          remoteJid,
          message,
          `${describeChannelSettings(channel)} Usage: /fast <on|off|default>`
        );
        return true;
      }
      const serviceTier = normalizeServiceTier(value);
      updateChannelSettings(channel, { serviceTier });
      await replyText(sock, remoteJid, message, `Updated. ${describeChannelSettings(channel)}`);
      return true;
    }
    case 'service-tier': {
      const value = command.rest.trim();
      if (!value) {
        await replyText(
          sock,
          remoteJid,
          message,
          `${describeChannelSettings(channel)} Usage: /service-tier <fast|default|tier-id>`
        );
        return true;
      }
      const serviceTier = normalizeServiceTier(value);
      updateChannelSettings(channel, { serviceTier });
      await replyText(sock, remoteJid, message, `Updated. ${describeChannelSettings(channel)}`);
      return true;
    }
    case 'reply':
      if (!command.rest) {
        await replyText(sock, remoteJid, message, 'Usage: /reply <message>');
        return true;
      }
      await ensureChannel(remoteJid);
      if (activeRuns.has(channel)) {
        steerActiveRunInBackground(sock, remoteJid, message, channel, command.rest);
        return true;
      }
      try {
        await streamPromptWithRecovery(sock, remoteJid, message, channel, command.rest, {
          quoted: true,
        });
      } finally {
        await sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
      }
      return true;
    case 'help':
      await replyText(
        sock,
        remoteJid,
        message,
        'Anya commands: /new, /reset, /stop, /status, /auth, /login, /update, /restart, /models, /model, /thinking, /fast, /service-tier, /settings, /reply, /help. In groups, mention anya or start with /anya or /ask to chat.'
      );
      return true;
  }
  return false;
}

async function handleMessage(sock, message) {
  if (message.key.fromMe) return;
  const remoteJid = message.key.remoteJid;
  if (!remoteJid || remoteJid === 'status@broadcast' || remoteJid.endsWith('@newsletter')) return;
  recordMessage(message);

  const rawText = extractText(message);
  const command = parseSlashCommand(rawText);
  const inboundMedia = mediaInfo(message);
  console.log(JSON.stringify({
    event: 'whatsapp_message',
    remoteJid,
    fromMe: message.key.fromMe,
    isGroup: isGroup(remoteJid),
    command: command?.name || null,
    mediaKind: inboundMedia?.kind || null,
    textLength: rawText.length,
  }));
  const access = isAllowedInbound(message, remoteJid);
  if (!access.allowed) {
    console.log(JSON.stringify({
      event: 'whatsapp_message_dropped',
      remoteJid,
      reason: access.reason,
    }));
    return;
  }
  if (isChannelSlashCommand(command)) {
    try {
      await handleSlashCommand(sock, remoteJid, message, command);
    } catch (error) {
      rememberAuthFailure(error);
      console.error(`Anya WhatsApp command error: ${error?.stack || error?.message || error}`);
      await replyText(sock, remoteJid, message, formatAnyaError(error));
    }
    return;
  }

  if (!shouldRespond(rawText, remoteJid, message, sock, Boolean(inboundMedia))) return;

  const text = stripInvocation(rawText, message, sock);
  if (!text && !inboundMedia) return;

  try {
    const attachment = await transcribeAudioAttachment(await downloadMediaAttachment(message));
    const prompt = promptWithQuotedMessageContext(
      promptWithMedia(text, attachment),
      quotedMessageContext(message)
    );
    const images = attachment?.imageInput ? [attachment.path] : [];
    await ensureCodexAuthReady();
    const channel = await ensureChannel(remoteJid);
    if (activeRuns.has(channel)) {
      steerActiveRunInBackground(sock, remoteJid, message, channel, prompt, { images });
      return;
    }

    await streamPromptWithRecovery(sock, remoteJid, message, channel, prompt, { images });
  } catch (error) {
    if (!isStoppedError(error)) {
      rememberAuthFailure(error);
      if (isAuthFailure(error)) stopActiveRun(channelName(remoteJid));
      console.error(`Anya WhatsApp message error: ${error?.stack || error?.message || error}`);
      await replyText(sock, remoteJid, message, formatAnyaError(error));
    }
  } finally {
    await sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
  }
}

let pairingCodeRequested = false;

async function requestPhonePairingCode(sock) {
  if (!pairPhoneNumber || pairingCodeRequested) return;
  pairingCodeRequested = true;
  try {
    const code = await sock.requestPairingCode(pairPhoneNumber);
    console.log(`WhatsApp pairing code for +${pairPhoneNumber}: ${code}`);
    console.log('Open WhatsApp on that phone, go to Linked devices, choose "Link with phone number instead", then enter the code.');
  } catch (error) {
    pairingCodeRequested = false;
    console.error(`Failed to request WhatsApp pairing code: ${error.message}`);
  }
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    auth: state,
    browser: Browsers.macOS('Desktop'),
    logger: Pino({ level: process.env.ANYA_WHATSAPP_LOG_LEVEL || 'fatal' }),
    printQRInTerminal: false,
    syncFullHistory: true,
    version,
  });
  currentSock = sock;

  if (pairPhoneNumber && !state.creds.registered) {
    setTimeout(() => void requestPhonePairingCode(sock), 2500);
  }

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('contacts.update', (contacts) => {
    for (const contact of contacts || []) {
      rememberContact(contact.id, contact);
    }
  });
  sock.ev.on('chats.update', (chats) => {
    for (const chat of chats || []) {
      rememberChat(chat.id, chat);
    }
  });
  sock.ev.on('messaging-history.set', ({ chats, contacts, messages }) => {
    for (const contact of contacts || []) {
      rememberContact(contact.id, contact);
    }
    for (const chat of chats || []) {
      rememberChat(chat.id, chat);
    }
    const changedJids = new Set();
    for (const message of messages || []) {
      const jid = recordMessage(message);
      if (jid) changedJids.add(jid);
    }
    console.log(JSON.stringify({
      event: 'whatsapp_history_sync',
      chats: chats?.length || 0,
      contacts: contacts?.length || 0,
      messages: messages?.length || 0,
      changedChats: changedJids.size,
    }));
    notifyHistoryMessages(changedJids);
  });
  startControlServer();
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr && !pairPhoneNumber) {
      console.log('Scan this QR code with WhatsApp:');
      qrcode.generate(qr, { small: true });
    } else if (qr && pairPhoneNumber) {
      void requestPhonePairingCode(sock);
    }
    if (connection === 'open') {
      console.log('Anya WhatsApp bridge connected.');
      setTimeout(() => void drainBridgeNotices(sock), 1500);
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode !== DisconnectReason.loggedOut) scheduleReconnect(lastDisconnect?.error);
      else console.log('WhatsApp logged out. Remove the session directory and pair again.');
    }
  });
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const message of messages) {
      try {
        await handleMessage(sock, message);
      } catch (error) {
        const remoteJid = message?.key?.remoteJid;
        console.error(`Anya WhatsApp unhandled message error: ${error?.stack || error?.message || error}`);
        queueBridgeNotice(remoteJid, bridgeNoticeText(error));
      }
    }
  });
}

function scheduleReconnect(error) {
  if (reconnectScheduled) return;
  reconnectScheduled = true;
  console.error(`Anya WhatsApp bridge reconnecting: ${error?.message || error || 'connection closed'}`);
  setTimeout(() => {
    reconnectScheduled = false;
    void start().catch((startError) => {
      console.error(`Anya WhatsApp reconnect failed: ${startError?.stack || startError?.message || startError}`);
      scheduleReconnect(startError);
    });
  }, 2000).unref?.();
}

function startControlServer() {
  if (controlServer) return;
  try {
    unlinkSync(controlSocketPath);
  } catch {
  }
  const server = createServer((connection) => {
    let buffer = '';
    connection.setEncoding('utf8');
    connection.on('data', (chunk) => {
      buffer += chunk;
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        void handleControlLine(currentSock, connection, line);
      }
    });
  });
  server.listen(controlSocketPath, () => {
    console.log(`Anya WhatsApp control socket listening at ${controlSocketPath}`);
  });
  controlServer = server;
}

async function handleControlLine(sock, connection, line) {
  try {
    if (!sock) throw new Error('WhatsApp bridge is not connected yet');
    const request = JSON.parse(line);
    let data;
    switch (request.action) {
      case 'send':
        data = await sendOutboundMessage(
          sock,
          request.to,
          String(request.text || ''),
          request.listenSecs,
          request.attachments || []
        );
        break;
      case 'contacts':
        data = { contacts: listKnownContacts(request.query) };
        break;
      case 'read':
        data = await readRecordedMessages(
          sock,
          request.chat,
          request.limit,
          request.messageId,
          request.around
        );
        break;
      case 'listen': {
        const jid = resolvePeer(request.chat);
        data = { jid, listeningUntil: openTemporaryInbound(jid, request.seconds || 300) };
        break;
      }
      default:
        throw new Error(`unknown WhatsApp control action: ${request.action}`);
    }
    connection.write(`${JSON.stringify({ ok: true, ...data })}\n`);
  } catch (error) {
    connection.write(`${JSON.stringify({ ok: false, error: error?.message || String(error) })}\n`);
  } finally {
    connection.end();
  }
}

process.on('unhandledRejection', (error) => {
  console.error(`Anya WhatsApp unhandled rejection: ${error?.stack || error?.message || error}`);
  queueBridgeNoticesForActiveRuns(error);
});

process.on('uncaughtException', (error) => {
  console.error(`Anya WhatsApp uncaught exception: ${error?.stack || error?.message || error}`);
  queueBridgeNoticesForActiveRuns(error);
  setTimeout(() => process.exit(1), 250).unref?.();
});

// Baileys can unref its socket timers after setup returns; keep this bridge
// process alive so it can continue receiving messages.
setInterval(() => {}, 60_000);

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    use pretty_assertions::assert_eq;

    use crate::Cli;
    use crate::CommandKind;

    #[test]
    fn service_unit_name_accepts_bare_name_or_unit() {
        assert_eq!("anya.service", service_unit_name("anya"));
        assert_eq!("anya.service", service_unit_name("anya.service"));
    }

    #[test]
    fn normalizes_pair_phone_number_to_digits() {
        assert_eq!(
            Some("15551234567".to_string()),
            normalize_pair_phone_number(Some("+1 (555) 123-4567".to_string())).unwrap()
        );
    }

    #[test]
    fn rejects_short_pair_phone_number() {
        assert!(normalize_pair_phone_number(Some("+12".to_string())).is_err());
    }

    #[test]
    fn parses_text_only_whatsapp_send() {
        let cli =
            Cli::try_parse_from(["anya", "whatsapp", "send", "--to", "+15551234567", "hello"])
                .unwrap();
        match cli.command {
            CommandKind::Whatsapp(args) => match args.command {
                WhatsappCommand::Send(args) => {
                    assert_eq!("+15551234567", args.to);
                    assert_eq!(Vec::<PathBuf>::new(), args.files);
                    assert_eq!(WhatsappMediaKind::Auto, args.media_kind);
                    assert_eq!(vec!["hello"], args.message);
                }
                other => panic!("unexpected WhatsApp command: {other:?}"),
            },
            other => panic!("unexpected command: {other:?}"),
        }
    }

    #[test]
    fn parses_media_only_whatsapp_send() {
        let cli = Cli::try_parse_from([
            "anya",
            "whatsapp",
            "send",
            "--to",
            "me",
            "--file",
            "/tmp/report.pdf",
        ])
        .unwrap();
        match cli.command {
            CommandKind::Whatsapp(args) => match args.command {
                WhatsappCommand::Send(args) => {
                    assert_eq!("me", args.to);
                    assert_eq!(vec![PathBuf::from("/tmp/report.pdf")], args.files);
                    assert_eq!(WhatsappMediaKind::Auto, args.media_kind);
                    assert!(args.message.is_empty());
                }
                other => panic!("unexpected WhatsApp command: {other:?}"),
            },
            other => panic!("unexpected command: {other:?}"),
        }
    }

    #[test]
    fn parses_whatsapp_send_files_caption_and_media_kind() {
        let cli = Cli::try_parse_from([
            "anya",
            "whatsapp",
            "send",
            "--to",
            "me",
            "--file",
            "/tmp/a.png",
            "--file",
            "/tmp/b.txt",
            "--media-kind",
            "document",
            "caption",
            "text",
        ])
        .unwrap();
        match cli.command {
            CommandKind::Whatsapp(args) => match args.command {
                WhatsappCommand::Send(args) => {
                    assert_eq!(
                        vec![PathBuf::from("/tmp/a.png"), PathBuf::from("/tmp/b.txt")],
                        args.files
                    );
                    assert_eq!(WhatsappMediaKind::Document, args.media_kind);
                    assert_eq!(vec!["caption", "text"], args.message);
                }
                other => panic!("unexpected WhatsApp command: {other:?}"),
            },
            other => panic!("unexpected command: {other:?}"),
        }
    }

    #[test]
    fn rejects_invalid_whatsapp_media_kind() {
        assert!(
            Cli::try_parse_from([
                "anya",
                "whatsapp",
                "send",
                "--to",
                "me",
                "--file",
                "/tmp/a.png",
                "--media-kind",
                "invalid",
            ])
            .is_err()
        );
    }

    #[test]
    fn parses_whatsapp_read_message_context_options() {
        let cli = Cli::try_parse_from([
            "anya",
            "whatsapp",
            "read",
            "--chat",
            "275397782540416@lid",
            "--message-id",
            "3EB0C8811D0D71FD1EA083",
            "--around",
            "12",
        ])
        .unwrap();
        match cli.command {
            CommandKind::Whatsapp(args) => match args.command {
                WhatsappCommand::Read(args) => {
                    assert_eq!("275397782540416@lid", args.chat);
                    assert_eq!(Some("3EB0C8811D0D71FD1EA083".to_string()), args.message_id);
                    assert_eq!(12, args.around);
                }
                other => panic!("unexpected WhatsApp command: {other:?}"),
            },
            other => panic!("unexpected command: {other:?}"),
        }
    }

    #[test]
    fn whatsapp_bridge_bounds_agent_runs() {
        assert!(BRIDGE_MJS.contains("ANYA_WHATSAPP_REPLY_TIMEOUT_MS"));
        assert!(BRIDGE_MJS.contains("ANYA_WHATSAPP_UPDATE_TIMEOUT_MS"));
        assert!(BRIDGE_MJS.contains("ANYA_WHATSAPP_DEVICE_LOGIN_TIMEOUT_MS"));
        assert!(BRIDGE_MJS.contains("ANYA_WHATSAPP_DEVICE_LOGIN_PROMPT_TIMEOUT_MS"));
        assert!(BRIDGE_MJS.contains("ANYA_WHATSAPP_AUTH_PREFLIGHT_TTL_MS"));
        assert!(BRIDGE_MJS.contains("ANYA_WHATSAPP_AUTH_PREFLIGHT_FAILURE_TTL_MS"));
        assert!(BRIDGE_MJS.contains("activeRuns = new Map()"));
        assert!(BRIDGE_MJS.contains("let activeDeviceLogin = false"));
        assert!(BRIDGE_MJS.contains("let activeUpdate = false"));
        assert!(BRIDGE_MJS.contains("authPreflight = {"));
        assert!(BRIDGE_MJS.contains("function ensureCodexAuthReady"));
        assert!(BRIDGE_MJS.contains("await ensureCodexAuthReady();"));
        assert!(BRIDGE_MJS.contains("function rememberAuthFailure"));
        assert!(BRIDGE_MJS.contains("child.kill('SIGKILL')"));
        assert!(BRIDGE_MJS.contains("Anya needs a fresh Codex login"));
        assert!(BRIDGE_MJS.contains("Send /login in this WhatsApp chat"));
        assert!(BRIDGE_MJS.contains("function runDeviceLoginFromWhatsapp"));
        assert!(BRIDGE_MJS.contains("function sendDeviceLoginPrompt"));
        assert!(BRIDGE_MJS.contains("function stripTerminalFormatting"));
        assert!(BRIDGE_MJS.contains("function redactDeviceLoginOutput"));
        assert!(BRIDGE_MJS.contains("login prompt parse failed"));
        assert!(BRIDGE_MJS.contains("function runUpdateFromWhatsapp"));
        assert!(BRIDGE_MJS.contains("--notify-channel"));
        assert!(BRIDGE_MJS.contains("Anya update completed and the service is back online."));
        assert!(BRIDGE_MJS.contains("prompt.url"));
        assert!(BRIDGE_MJS.contains("prompt.code"));
        assert!(BRIDGE_MJS.contains("Enter this code:"));
        assert!(BRIDGE_MJS.contains("could not read the OpenAI device URL and code"));
        assert!(BRIDGE_MJS.contains("[A-Z0-9]{4}[-\\s][A-Z0-9]{4,8}"));
        assert!(BRIDGE_MJS.contains("function scheduleServiceRestart"));
        assert!(BRIDGE_MJS.contains("systemd-run"));
    }

    #[test]
    fn whatsapp_bridge_handles_channel_slash_commands() {
        assert!(BRIDGE_MJS.contains("parseSlashCommand"));
        assert!(BRIDGE_MJS.contains("'auth'"));
        assert!(BRIDGE_MJS.contains("'login'"));
        assert!(BRIDGE_MJS.contains("'update'"));
        assert!(BRIDGE_MJS.contains("'restart'"));
        assert!(BRIDGE_MJS.contains("'models'"));
        assert!(BRIDGE_MJS.contains("'model'"));
        assert!(BRIDGE_MJS.contains("'thinking'"));
        assert!(BRIDGE_MJS.contains("Started a new Anya session for this channel."));
        assert!(BRIDGE_MJS.contains("Stopped the active Anya reply for this channel."));
        assert!(BRIDGE_MJS.contains("streamPromptWithRecovery"));
        assert!(BRIDGE_MJS.contains("--stream-json"));
        assert!(BRIDGE_MJS.contains("{ quoted }"));
        assert!(BRIDGE_MJS.contains("ANYA_WHATSAPP_STREAM_REPLIES"));
        assert!(BRIDGE_MJS.contains("ANYA_WHATSAPP_STREAM_FLUSH_MS"));
        assert!(BRIDGE_MJS.contains("ANYA_WHATSAPP_STREAM_FLUSH_CHARS"));
        assert!(
            BRIDGE_MJS.contains("parseBoolEnv(process.env.ANYA_WHATSAPP_STREAM_REPLIES, true)")
        );
        assert!(BRIDGE_MJS.contains("callbacks.onMessageDelta?.(event.delta || '', event)"));
        assert!(BRIDGE_MJS.contains("let activeMessageItemId = null"));
        assert!(BRIDGE_MJS.contains("event?.item_id && activeMessageItemId"));
        assert!(BRIDGE_MJS.contains("function strongChunkEnd(text)"));
        assert!(BRIDGE_MJS.contains("function naturalChunkEnd(text)"));
        assert!(BRIDGE_MJS.contains("function wordBoundaryEnd(text, limit)"));
        assert!(BRIDGE_MJS.contains("const nextFlushChunk = (force = false)"));
        assert!(BRIDGE_MJS.contains("setTimeout(() => flush(false), streamFlushMs)"));
        assert!(BRIDGE_MJS.contains("buffer.length >= streamFlushChars"));
        assert!(BRIDGE_MJS.contains(
            "Anya commands: /new, /reset, /stop, /status, /auth, /login, /update, /restart"
        ));
    }

    #[test]
    fn whatsapp_bridge_enforces_access_config() {
        assert!(BRIDGE_MJS.contains("ANYA_WHATSAPP_DM_POLICY"));
        assert!(BRIDGE_MJS.contains("ANYA_WHATSAPP_GROUP_POLICY"));
        assert!(BRIDGE_MJS.contains("ANYA_WHATSAPP_ALLOW_FROM"));
        assert!(BRIDGE_MJS.contains("ANYA_WHATSAPP_BLOCK_FROM"));
        assert!(BRIDGE_MJS.contains("whatsapp_message_dropped"));
    }

    #[test]
    fn whatsapp_bridge_downloads_media_attachments() {
        assert!(BRIDGE_MJS.contains("downloadContentFromMessage"));
        assert!(BRIDGE_MJS.contains("ANYA_WHATSAPP_MEDIA_DIR"));
        assert!(BRIDGE_MJS.contains("ANYA_WHATSAPP_MAX_MEDIA_BYTES"));
        assert!(BRIDGE_MJS.contains("ANYA_WHATSAPP_TRANSCRIBE_AUDIO"));
        assert!(BRIDGE_MJS.contains("faster-whisper"));
        assert!(BRIDGE_MJS.contains("WhatsApp ${attachment.promptLabel} transcription:"));
        assert!(BRIDGE_MJS.contains("Source ${attachment.promptLabel} file, only if needed:"));
        assert!(BRIDGE_MJS.contains("payload.imageMessage"));
        assert!(BRIDGE_MJS.contains("payload.videoMessage"));
        assert!(BRIDGE_MJS.contains("payload.audioMessage"));
        assert!(BRIDGE_MJS.contains("payload.documentMessage"));
        assert!(BRIDGE_MJS.contains("payload.stickerMessage"));
        assert!(BRIDGE_MJS.contains("documentWithCaptionMessage"));
    }

    #[test]
    fn whatsapp_bridge_passes_images_to_anya() {
        assert!(BRIDGE_MJS.contains("args.push('--image', image);"));
        assert!(BRIDGE_MJS.contains("Attached as an image input."));
        assert!(BRIDGE_MJS.contains("Use local shell tools on the saved file"));
        assert!(BRIDGE_MJS.contains("mediaKind: inboundMedia?.kind || null"));
    }

    #[test]
    fn whatsapp_bridge_steers_active_runs() {
        assert!(BRIDGE_MJS.contains("session-steer"));
        assert!(BRIDGE_MJS.contains("turn_accepted"));
        assert!(BRIDGE_MJS.contains("waitForActiveTurnId"));
        assert!(BRIDGE_MJS.contains("steerActiveRunInBackground"));
        assert!(BRIDGE_MJS.contains("activeTurnIdFromMismatch"));
        assert!(BRIDGE_MJS.contains("parseTurnSteerResponse"));
        assert!(BRIDGE_MJS.contains("Anya WhatsApp steer retrying with active turn id"));
        assert!(!BRIDGE_MJS.contains("Anya is already replying in this channel"));
    }

    #[test]
    fn whatsapp_bridge_supports_channel_model_settings() {
        assert!(BRIDGE_MJS.contains("ANYA_WHATSAPP_CHANNEL_SETTINGS_PATH"));
        assert!(BRIDGE_MJS.contains("channel-settings.json"));
        assert!(BRIDGE_MJS.contains("function normalizeReasoningEffort"));
        assert!(BRIDGE_MJS.contains("function normalizeServiceTier"));
        assert!(BRIDGE_MJS.contains("args.push('--model', settings.model)"));
        assert!(BRIDGE_MJS.contains("args.push('--effort', settings.effort)"));
        assert!(BRIDGE_MJS.contains("args.push('--service-tier', settings.serviceTier)"));
        assert!(BRIDGE_MJS.contains("'models', '--endpoint', endpoint, '--format', 'whatsapp'"));
        assert!(BRIDGE_MJS.contains("Usage: /model <model-id|default>"));
        assert!(
            BRIDGE_MJS.contains("Usage: /thinking <none|minimal|low|medium|high|xhigh|default>")
        );
        assert!(BRIDGE_MJS.contains("Usage: /fast <on|off|default>"));
        assert!(BRIDGE_MJS.contains("Usage: /service-tier <fast|default|tier-id>"));
        assert!(BRIDGE_MJS.contains("Fast: ${fastMode}"));
    }

    #[test]
    fn whatsapp_bridge_exposes_agent_control_socket() {
        assert!(BRIDGE_MJS.contains("ANYA_WHATSAPP_CONTROL_SOCKET"));
        assert!(BRIDGE_MJS.contains("function startControlServer"));
        assert!(BRIDGE_MJS.contains("let currentSock = null"));
        assert!(BRIDGE_MJS.contains("sendOutboundMessage"));
        assert!(BRIDGE_MJS.contains("readRecordedMessages"));
        assert!(BRIDGE_MJS.contains("listKnownContacts"));
        assert!(BRIDGE_MJS.contains("temporaryInboundAllows"));
        assert!(BRIDGE_MJS.contains("messaging-history.set"));
    }

    #[test]
    fn whatsapp_bridge_recovers_from_send_crashes() {
        assert!(BRIDGE_MJS.contains("ANYA_WHATSAPP_BRIDGE_NOTICE_PATH"));
        assert!(BRIDGE_MJS.contains("ANYA_WHATSAPP_SEND_RETRY_MS"));
        assert!(BRIDGE_MJS.contains("function sendMessageWithRetry"));
        assert!(BRIDGE_MJS.contains("function queueBridgeNotice"));
        assert!(BRIDGE_MJS.contains("function drainBridgeNotices"));
        assert!(
            BRIDGE_MJS.contains("Anya WhatsApp bridge lost its connection while sending a reply")
        );
        assert!(BRIDGE_MJS.contains("process.on('unhandledRejection'"));
        assert!(BRIDGE_MJS.contains("process.on('uncaughtException'"));
        assert!(BRIDGE_MJS.contains("function scheduleReconnect"));
        assert!(BRIDGE_MJS.contains("sendPresenceUpdate('paused', remoteJid).catch"));
    }

    #[test]
    fn whatsapp_bridge_sends_outbound_media_attachments() {
        assert!(BRIDGE_MJS.contains("attachments"));
        assert!(BRIDGE_MJS.contains("function sendOutboundAttachment"));
        assert!(BRIDGE_MJS.contains("function inferOutboundMediaKind"));
        assert!(BRIDGE_MJS.contains("function outboundMimeTypeForPath"));
        assert!(BRIDGE_MJS.contains("statSync(path)"));
        assert!(BRIDGE_MJS.contains("accessSync(path, fsConstants.R_OK)"));
        assert!(BRIDGE_MJS.contains("image: { url: attachment.path }"));
        assert!(BRIDGE_MJS.contains("video: { url: attachment.path }"));
        assert!(BRIDGE_MJS.contains("audio: { url: attachment.path }"));
        assert!(BRIDGE_MJS.contains("document: { url: attachment.path }"));
        assert!(BRIDGE_MJS.contains("ptt: true"));
        assert!(BRIDGE_MJS.contains("mediaKind: attachment.mediaKind"));
        assert!(BRIDGE_MJS.contains("sizeBytes: attachment.sizeBytes"));
        assert!(BRIDGE_MJS.contains("promptWithWhatsappContext"));
        assert!(BRIDGE_MJS.contains("--file \"/path/to/file\""));
    }

    #[test]
    fn whatsapp_bridge_includes_quoted_message_context() {
        assert!(BRIDGE_MJS.contains("function contextInfoForMessage"));
        assert!(BRIDGE_MJS.contains("function quotedMessageReference"));
        assert!(BRIDGE_MJS.contains("contextInfo.quotedMessage"));
        assert!(BRIDGE_MJS.contains("contextInfo.stanzaId"));
        assert!(BRIDGE_MJS.contains("quotedMessageId"));
        assert!(BRIDGE_MJS.contains("WhatsApp reply context:"));
        assert!(BRIDGE_MJS.contains("Quoted payload was not embedded"));
        assert!(BRIDGE_MJS.contains("--message-id"));
        assert!(BRIDGE_MJS.contains("function recordedMessageWindow"));
        assert!(BRIDGE_MJS.contains("request.messageId"));
    }

    #[test]
    fn whatsapp_bridge_syncs_chat_history_for_reads() {
        assert!(BRIDGE_MJS.contains("syncFullHistory: true"));
        assert!(BRIDGE_MJS.contains("Browsers.macOS('Desktop')"));
        assert!(BRIDGE_MJS.contains("function syncChatHistory"));
        assert!(BRIDGE_MJS.contains("sock.fetchMessageHistory"));
        assert!(BRIDGE_MJS.contains("no_anchor_message"));
        assert!(BRIDGE_MJS.contains("whatsapp_history_sync"));
        assert!(BRIDGE_MJS.contains("notifyHistoryMessages"));
    }
}
