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
struct WhatsappBridgeArgs {
    #[arg(long)]
    dir: Option<PathBuf>,
    #[arg(long, env = "ANYA_ENDPOINT", default_value = "ws://127.0.0.1:4827")]
    endpoint: String,
    #[arg(long, default_value = "whatsapp")]
    channel_prefix: String,
    #[arg(long, default_value = "anya")]
    bot_name: String,
    #[arg(long)]
    anya_binary: Option<PathBuf>,
}

#[derive(Debug, Args)]
struct WhatsappServiceArgs {
    #[arg(long)]
    dir: Option<PathBuf>,
    #[arg(long, default_value = "anya-whatsapp")]
    name: String,
    #[arg(long)]
    anya_binary: Option<PathBuf>,
}

pub async fn run(args: WhatsappArgs) -> Result<()> {
    match args.command {
        WhatsappCommand::Install(args) => install(args).await,
        WhatsappCommand::Bridge(args) => bridge(args).await,
        WhatsappCommand::PrintService(args) => print_service(args),
    }
}

async fn install(args: WhatsappInstallArgs) -> Result<()> {
    let dir = bridge_dir(args.dir)?;
    tokio::fs::create_dir_all(&dir).await?;
    write_file(dir.join("package.json"), PACKAGE_JSON).await?;
    write_file(dir.join("bridge.mjs"), BRIDGE_MJS).await?;

    if !args.skip_npm_install {
        let status = Command::new("npm")
            .arg("install")
            .current_dir(&dir)
            .stdin(Stdio::null())
            .status()
            .await
            .context("run npm install for WhatsApp bridge")?;
        if !status.success() {
            anyhow::bail!("npm install failed with {status}");
        }
    }

    println!("{}", dir.display());
    Ok(())
}

async fn bridge(args: WhatsappBridgeArgs) -> Result<()> {
    let dir = bridge_dir(args.dir)?;
    if !dir.join("bridge.mjs").exists() {
        install(WhatsappInstallArgs {
            dir: Some(dir.clone()),
            skip_npm_install: false,
        })
        .await?;
    }

    let anya_binary = args
        .anya_binary
        .unwrap_or_else(|| std::env::current_exe().unwrap_or_else(|_| PathBuf::from("anya")));
    let status = Command::new("node")
        .arg(dir.join("bridge.mjs"))
        .env("ANYA_BINARY", anya_binary)
        .env("ANYA_ENDPOINT", args.endpoint)
        .env("ANYA_CHANNEL_PREFIX", args.channel_prefix)
        .env("ANYA_BOT_NAME", args.bot_name)
        .env("ANYA_WHATSAPP_SESSION_DIR", dir.join("session"))
        .current_dir(&dir)
        .status()
        .await
        .context("run WhatsApp bridge")?;
    if !status.success() {
        anyhow::bail!("WhatsApp bridge exited with {status}");
    }
    Ok(())
}

fn print_service(args: WhatsappServiceArgs) -> Result<()> {
    let dir = bridge_dir(args.dir)?;
    let binary = args
        .anya_binary
        .unwrap_or_else(|| std::env::current_exe().unwrap_or_else(|_| PathBuf::from("anya")));
    println!("{}", whatsapp_systemd_unit(&binary, &dir).trim_end());
    Ok(())
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

function mentionedBot(message, sock) {
  const mentions =
    message?.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  const own = sock.user?.id?.split(':')[0];
  return own ? mentions.some((jid) => jid.includes(own)) : false;
}

function stripInvocation(text) {
  const trimmed = text.trim();
  const patterns = [
    new RegExp(`^@?${botName}[,:\\s]+`, 'i'),
    /^\/anya(?:@\S+)?\s+/i,
    /^\/ask(?:@\S+)?\s+/i,
  ];
  for (const pattern of patterns) {
    if (pattern.test(trimmed)) return trimmed.replace(pattern, '').trim();
  }
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

  const text = stripInvocation(rawText);
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

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    auth: state,
    logger: Pino({ level: process.env.ANYA_WHATSAPP_LOG_LEVEL || 'warn' }),
    printQRInTerminal: false,
    version,
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('Scan this QR code with WhatsApp:');
      qrcode.generate(qr, { small: true });
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

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
"#;

#[cfg(test)]
mod tests {
    use super::*;

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
}
