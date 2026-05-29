use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use anyhow::Context;
use anyhow::Result;
use clap::Args;
use clap::Subcommand;
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

#[derive(Debug, Clone, Deserialize, Serialize)]
struct WhatsappBridgeConfig {
    endpoint: String,
    channel_prefix: String,
    bot_name: String,
    phone_number: Option<String>,
}

pub async fn run(args: WhatsappArgs) -> Result<()> {
    match args.command {
        WhatsappCommand::Setup(args) => setup(args).await,
        WhatsappCommand::Install(args) => install(args).await,
        WhatsappCommand::Bridge(args) => bridge(args).await,
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
            std::thread::sleep(Duration::from_secs(2));
        }
    });
    Ok(Some(handle))
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
        .current_dir(dir);
    if let Some(phone_number) = &config.phone_number {
        command.env("ANYA_WHATSAPP_PAIR_PHONE", phone_number);
    }
    command
}

async fn run_systemctl(args: &[&str], action: &str) -> Result<()> {
    let output = Command::new("systemctl")
        .args(args)
        .stdin(Stdio::null())
        .output()
        .await
        .with_context(|| format!("{action} with systemctl"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        anyhow::bail!("systemctl failed to {action}: {detail}");
    }
    Ok(())
}

async fn restart_gateway_service(service_name: &str) -> Result<()> {
    let service_unit = service_unit_name(service_name);
    run_systemctl(
        &["--user", "restart", &service_unit],
        "restart Anya service",
    )
    .await?;
    println!("Restarted gateway service: {service_unit}");
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
    println!("  systemctl --user restart {service_unit}");
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
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import Pino from 'pino';
import qrcode from 'qrcode-terminal';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const anyaBinary = process.env.ANYA_BINARY || 'anya';
const endpoint = process.env.ANYA_ENDPOINT || 'ws://127.0.0.1:4827';
const channelPrefix = process.env.ANYA_CHANNEL_PREFIX || 'whatsapp';
const botName = (process.env.ANYA_BOT_NAME || 'anya').toLowerCase();
const pairPhoneNumber = (process.env.ANYA_WHATSAPP_PAIR_PHONE || '').replace(/\D/g, '');
const commandTimeoutMs = parseTimeout(
  process.env.ANYA_WHATSAPP_COMMAND_TIMEOUT_MS,
  30_000
);
const replyTimeoutMs = parseTimeout(
  process.env.ANYA_WHATSAPP_REPLY_TIMEOUT_MS,
  120_000
);
const sessionDir =
  process.env.ANYA_WHATSAPP_SESSION_DIR ||
  join(process.env.HOME || '.', '.local', 'share', 'anya', 'whatsapp', 'session');
const activeRuns = new Map();

mkdirSync(sessionDir, { recursive: true });

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

function channelName(remoteJid) {
  return `${channelPrefix}:${remoteJid}`;
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
  const m = message?.message;
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

function isGroup(remoteJid) {
  return remoteJid.endsWith('@g.us');
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentionedBot(message, sock) {
  const mentions =
    message?.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
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

function shouldRespond(text, remoteJid, message, sock) {
  if (!text) return false;
  if (!isGroup(remoteJid)) return true;
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
  return ['new', 'reset', 'stop', 'status', 'help', 'reply'].includes(command?.name);
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
    return 'Anya needs a fresh Codex login on this server. Run: anya login --device-auth';
  }
  if (message.includes('timed out')) {
    return 'Anya timed out waiting for Codex. Run: anya auth status';
  }
  if (message.includes('failed to load configuration') || message.includes('Model provider')) {
    return `Anya configuration error: ${message}`;
  }
  return `Anya error: ${message}`;
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
  await sock.sendMessage(remoteJid, { text }, sendOptions);
}

function sendPrompt(channel, text) {
  return runAnya([
    'session-send',
    '--endpoint',
    endpoint,
    '--channel',
    channel,
    '--wait',
    text,
  ], {
    activeKey: channel,
    timeoutMs: replyTimeoutMs,
  });
}

async function sendPromptWithRecovery(remoteJid, channel, text) {
  try {
    return await sendPrompt(channel, text);
  } catch (error) {
    if (!isThreadNotFoundError(error)) throw error;
    await createChannelSession(remoteJid);
    return await sendPrompt(channel, text);
  }
}

async function handleSlashCommand(sock, remoteJid, message, command) {
  const channel = channelName(remoteJid);
  switch (command.name) {
    case 'new':
    case 'reset':
      stopActiveRun(channel);
      await createChannelSession(remoteJid);
      if (command.rest) {
        await sock.sendPresenceUpdate('composing', remoteJid);
        try {
          const reply = (await sendPrompt(channel, command.rest)).trim();
          if (reply) await replyText(sock, remoteJid, message, reply);
        } finally {
          await sock.sendPresenceUpdate('paused', remoteJid);
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
        `Anya is connected. Channel: ${channel}. Active reply: ${activeRuns.has(channel) ? 'yes' : 'no'}.`
      );
      return true;
    case 'reply':
      if (!command.rest) {
        await replyText(sock, remoteJid, message, 'Usage: /reply <message>');
        return true;
      }
      await ensureChannel(remoteJid);
      if (activeRuns.has(channel)) {
        await replyText(
          sock,
          remoteJid,
          message,
          'Anya is already replying in this channel. Send /stop to cancel it first.'
        );
        return true;
      }
      await sock.sendPresenceUpdate('composing', remoteJid);
      try {
        const reply = (await sendPromptWithRecovery(remoteJid, channel, command.rest)).trim();
        if (reply) await replyText(sock, remoteJid, message, reply, { quoted: true });
      } finally {
        await sock.sendPresenceUpdate('paused', remoteJid);
      }
      return true;
    case 'help':
      await replyText(
        sock,
        remoteJid,
        message,
        'Anya commands: /new, /reset, /stop, /status, /reply, /help. In groups, mention anya or start with /anya or /ask to chat.'
      );
      return true;
  }
  return false;
}

async function handleMessage(sock, message) {
  if (message.key.fromMe) return;
  const remoteJid = message.key.remoteJid;
  if (!remoteJid || remoteJid === 'status@broadcast') return;

  const rawText = extractText(message);
  const command = parseSlashCommand(rawText);
  console.log(JSON.stringify({
    event: 'whatsapp_message',
    remoteJid,
    fromMe: message.key.fromMe,
    isGroup: isGroup(remoteJid),
    command: command?.name || null,
    textLength: rawText.length,
  }));
  if (isChannelSlashCommand(command)) {
    try {
      await handleSlashCommand(sock, remoteJid, message, command);
    } catch (error) {
      console.error(`Anya WhatsApp command error: ${error?.stack || error?.message || error}`);
      await replyText(sock, remoteJid, message, formatAnyaError(error));
    }
    return;
  }

  if (!shouldRespond(rawText, remoteJid, message, sock)) return;

  const text = stripInvocation(rawText, message, sock);
  if (!text) return;

  try {
    const channel = await ensureChannel(remoteJid);
    if (activeRuns.has(channel)) {
      await replyText(
        sock,
        remoteJid,
        message,
        'Anya is already replying in this channel. Send /stop to cancel it first.'
      );
      return;
    }

    await sock.sendPresenceUpdate('composing', remoteJid);
    const reply = (await sendPromptWithRecovery(remoteJid, channel, text)).trim();
    if (reply) {
      await replyText(sock, remoteJid, message, reply);
    }
  } catch (error) {
    if (!isStoppedError(error)) {
      console.error(`Anya WhatsApp message error: ${error?.stack || error?.message || error}`);
      await replyText(sock, remoteJid, message, formatAnyaError(error));
    }
  } finally {
    await sock.sendPresenceUpdate('paused', remoteJid);
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
    logger: Pino({ level: process.env.ANYA_WHATSAPP_LOG_LEVEL || 'fatal' }),
    printQRInTerminal: false,
    version,
  });

  if (pairPhoneNumber && !state.creds.registered) {
    setTimeout(() => void requestPhonePairingCode(sock), 2500);
  }

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr && !pairPhoneNumber) {
      console.log('Scan this QR code with WhatsApp:');
      qrcode.generate(qr, { small: true });
    } else if (qr && pairPhoneNumber) {
      void requestPhonePairingCode(sock);
    }
    if (connection === 'open') {
      console.log('Anya WhatsApp bridge connected.');
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode !== DisconnectReason.loggedOut) start();
      else console.log('WhatsApp logged out. Remove the session directory and pair again.');
    }
  });
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const message of messages) {
      await handleMessage(sock, message);
    }
  });
}

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
    use pretty_assertions::assert_eq;

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
    fn whatsapp_bridge_bounds_agent_runs() {
        assert!(BRIDGE_MJS.contains("ANYA_WHATSAPP_REPLY_TIMEOUT_MS"));
        assert!(BRIDGE_MJS.contains("activeRuns = new Map()"));
        assert!(BRIDGE_MJS.contains("child.kill('SIGKILL')"));
        assert!(BRIDGE_MJS.contains("Anya needs a fresh Codex login"));
    }

    #[test]
    fn whatsapp_bridge_handles_channel_slash_commands() {
        assert!(BRIDGE_MJS.contains("parseSlashCommand"));
        assert!(BRIDGE_MJS.contains("['new', 'reset', 'stop', 'status', 'help', 'reply']"));
        assert!(BRIDGE_MJS.contains("Started a new Anya session for this channel."));
        assert!(BRIDGE_MJS.contains("Stopped the active Anya reply for this channel."));
        assert!(BRIDGE_MJS.contains("sendPromptWithRecovery"));
        assert!(BRIDGE_MJS.contains("{ quoted: true }"));
    }
}
