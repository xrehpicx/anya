use std::path::PathBuf;
use std::process::Stdio;

use anyhow::Context;
use anyhow::Result;
use clap::Args;
use clap::Subcommand;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

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
    /// Print a systemd user unit for the WhatsApp bridge.
    PrintService(WhatsappServiceArgs),
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
    /// Write ~/.config/systemd/user/anya-whatsapp.service during setup.
    #[arg(long)]
    install_user_service: bool,
    #[arg(long, default_value = "anya-whatsapp")]
    service_name: String,
    /// Install files and optional service unit without starting the bridge.
    #[arg(long)]
    no_run: bool,
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

#[derive(Debug, Args)]
struct WhatsappServiceArgs {
    #[arg(long)]
    dir: Option<PathBuf>,
    #[arg(long)]
    anya_binary: Option<PathBuf>,
}

pub async fn run(args: WhatsappArgs) -> Result<()> {
    match args.command {
        WhatsappCommand::Setup(args) => setup(args).await,
        WhatsappCommand::Install(args) => install(args).await,
        WhatsappCommand::Bridge(args) => bridge(args).await,
        WhatsappCommand::PrintService(args) => print_service(args),
    }
}

async fn install(args: WhatsappInstallArgs) -> Result<()> {
    let dir = bridge_dir(args.dir)?;
    install_bridge_files(&dir, args.skip_npm_install).await?;
    println!("{}", dir.display());
    Ok(())
}

async fn setup(args: WhatsappSetupArgs) -> Result<()> {
    if args.install_user_service && !cfg!(target_os = "linux") {
        anyhow::bail!("--install-user-service is only supported on Linux");
    }
    let dir = bridge_dir(args.dir)?;
    install_bridge_files(&dir, args.skip_npm_install).await?;

    let anya_binary = resolve_anya_binary(args.anya_binary);
    if args.install_user_service {
        install_user_service(&args.service_name, &anya_binary, &dir).await?;
    }

    println!("WhatsApp bridge installed in {}", dir.display());
    if args.no_run {
        if !args.install_user_service {
            print_setup_next_steps(&dir);
        }
        return Ok(());
    }

    if args.phone_number.is_some() {
        println!(
            "Starting WhatsApp bridge. Use the pairing code printed below from WhatsApp > Linked devices > Link with phone number instead."
        );
    } else {
        println!("Starting WhatsApp bridge. Scan the QR from WhatsApp > Linked devices.");
    }

    bridge(WhatsappBridgeArgs {
        dir: Some(dir),
        endpoint: args.endpoint,
        channel_prefix: args.channel_prefix,
        bot_name: args.bot_name,
        phone_number: args.phone_number,
        anya_binary: Some(anya_binary),
    })
    .await
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
    let phone_number = normalize_pair_phone_number(args.phone_number)?;
    let mut command = Command::new("node");
    command
        .arg(dir.join("bridge.mjs"))
        .env("ANYA_BINARY", anya_binary)
        .env("ANYA_ENDPOINT", args.endpoint)
        .env("ANYA_CHANNEL_PREFIX", args.channel_prefix)
        .env("ANYA_BOT_NAME", args.bot_name)
        .env("ANYA_WHATSAPP_SESSION_DIR", dir.join("session"))
        .current_dir(&dir);
    if let Some(phone_number) = phone_number {
        command.env("ANYA_WHATSAPP_PAIR_PHONE", phone_number);
    }

    let status = command.status().await.context("run WhatsApp bridge")?;
    if !status.success() {
        anyhow::bail!("WhatsApp bridge exited with {status}");
    }
    Ok(())
}

fn print_service(args: WhatsappServiceArgs) -> Result<()> {
    let dir = bridge_dir(args.dir)?;
    let binary = resolve_anya_binary(args.anya_binary);
    println!("{}", whatsapp_systemd_unit(&binary, &dir).trim_end());
    Ok(())
}

async fn install_user_service(
    service_name: &str,
    binary: &std::path::Path,
    dir: &std::path::Path,
) -> Result<()> {
    if !cfg!(target_os = "linux") {
        anyhow::bail!("--install-user-service is only supported on Linux");
    }
    let config_dir = dirs::config_dir()
        .context("resolve user config directory")?
        .join("systemd")
        .join("user");
    tokio::fs::create_dir_all(&config_dir).await?;
    let path = config_dir.join(format!("{service_name}.service"));
    write_file(path.clone(), &whatsapp_systemd_unit(binary, dir)).await?;
    println!("Installed user service: {}", path.display());
    println!("Run: systemctl --user daemon-reload");
    println!("Run: systemctl --user enable --now {service_name}.service");
    Ok(())
}

fn print_setup_next_steps(dir: &std::path::Path) {
    println!("Next steps:");
    println!("  anya whatsapp bridge --dir {}", dir.display());
    println!(
        "  anya whatsapp print-service --anya-binary ~/.local/bin/anya > ~/.config/systemd/user/anya-whatsapp.service"
    );
    println!("  systemctl --user daemon-reload");
    println!("  systemctl --user enable --now anya-whatsapp.service");
}

fn whatsapp_systemd_unit(binary: &std::path::Path, dir: &std::path::Path) -> String {
    format!(
        concat!(
            "[Unit]\n",
            "Description=Anya WhatsApp bridge\n",
            "After=network-online.target anya.service\n",
            "Wants=network-online.target anya.service\n\n",
            "[Service]\n",
            "Type=simple\n",
            "Restart=on-failure\n",
            "RestartSec=2s\n",
            "ExecStart={} whatsapp bridge --dir {}\n\n",
            "[Install]\n",
            "WantedBy=default.target\n"
        ),
        binary.display(),
        dir.display()
    )
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
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const anyaBinary = process.env.ANYA_BINARY || 'anya';
const endpoint = process.env.ANYA_ENDPOINT || 'ws://127.0.0.1:4827';
const channelPrefix = process.env.ANYA_CHANNEL_PREFIX || 'whatsapp';
const botName = (process.env.ANYA_BOT_NAME || 'anya').toLowerCase();
const pairPhoneNumber = (process.env.ANYA_WHATSAPP_PAIR_PHONE || '').replace(/\D/g, '');
const sessionDir =
  process.env.ANYA_WHATSAPP_SESSION_DIR ||
  join(process.env.HOME || '.', '.local', 'share', 'anya', 'whatsapp', 'session');

mkdirSync(sessionDir, { recursive: true });

function runAnya(args) {
  const result = spawnSync(anyaBinary, args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    const stdout = (result.stdout || '').trim();
    throw new Error(stderr || stdout || `anya exited with ${result.status}`);
  }
  return result.stdout || '';
}

function channelName(remoteJid) {
  return `${channelPrefix}:${remoteJid}`;
}

function ensureChannel(remoteJid) {
  const channel = channelName(remoteJid);
  const resolve = spawnSync(anyaBinary, ['channel', 'resolve', channel], {
    encoding: 'utf8',
  });
  if (resolve.status === 0 && resolve.stdout.trim()) return channel;
  runAnya(['session-create', '--endpoint', endpoint, '--channel', channel]);
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

async function handleMessage(sock, message) {
  if (message.key.fromMe) return;
  const remoteJid = message.key.remoteJid;
  if (!remoteJid || remoteJid === 'status@broadcast') return;

  const rawText = extractText(message);
  if (!shouldRespond(rawText, remoteJid, message, sock)) return;

  const text = stripInvocation(rawText, message, sock);
  if (!text) return;

  const channel = ensureChannel(remoteJid);
  await sock.sendPresenceUpdate('composing', remoteJid);
  try {
    const reply = runAnya([
      'session-send',
      '--endpoint',
      endpoint,
      '--channel',
      channel,
      '--wait',
      text,
    ]).trim();
    if (reply) {
      await sock.sendMessage(remoteJid, { text: reply }, { quoted: message });
    }
  } catch (error) {
    await sock.sendMessage(
      remoteJid,
      { text: `Anya error: ${error.message}` },
      { quoted: message }
    );
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
    logger: Pino({ level: process.env.ANYA_WHATSAPP_LOG_LEVEL || 'warn' }),
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
    fn whatsapp_user_service_targets_default_target() {
        let unit = whatsapp_systemd_unit(
            std::path::Path::new("/home/raj/.local/bin/anya"),
            std::path::Path::new("/home/raj/.local/share/anya/whatsapp"),
        );

        assert!(unit.contains("WantedBy=default.target\n"));
        assert!(unit.contains(
            "ExecStart=/home/raj/.local/bin/anya whatsapp bridge --dir /home/raj/.local/share/anya/whatsapp\n"
        ));
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
}
