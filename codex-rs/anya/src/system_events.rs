use std::path::PathBuf;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use anyhow::Context;
use anyhow::Result;
use clap::Args;
use clap::Subcommand;
use serde::Deserialize;
use serde::Serialize;
use tokio::task::JoinHandle;

use crate::channel::ChannelStore;
use crate::codex_rpc::CodexRpcClient;
use crate::whatsapp;

const STARTUP_DRAIN_RETRY_SECS: u64 = 5;
const STARTUP_DRAIN_TIMEOUT_SECS: u64 = 180;

#[derive(Debug, Args)]
pub(crate) struct SystemEventArgs {
    #[command(subcommand)]
    pub(crate) command: SystemEventCommand,
}

#[derive(Debug, Subcommand)]
pub(crate) enum SystemEventCommand {
    /// Queue a system event for the next Anya service startup.
    Enqueue(SystemEventEnqueueArgs),
    /// List queued system events.
    List(SystemEventListArgs),
    /// Drain queued system events now.
    Drain(SystemEventDrainArgs),
}

#[derive(Debug, Args)]
pub(crate) struct SystemEventEnqueueArgs {
    /// Channel to notify or resume, e.g. whatsapp:<jid>.
    #[arg(long)]
    pub(crate) channel: String,

    /// Send this exact text directly instead of asking the agent to handle it.
    #[arg(long)]
    pub(crate) direct: bool,

    /// Event message or instruction.
    #[arg(required = true)]
    pub(crate) message: Vec<String>,
}

#[derive(Debug, Args)]
pub(crate) struct SystemEventListArgs {
    /// Print queued events as JSON.
    #[arg(long)]
    pub(crate) json: bool,
}

#[derive(Debug, Args)]
pub(crate) struct SystemEventDrainArgs {
    /// App-server endpoint.
    #[arg(long, env = "ANYA_ENDPOINT", default_value = "ws://127.0.0.1:4827")]
    pub(crate) endpoint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SystemEventKind {
    DirectNotification,
    AgentPrompt,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SystemEvent {
    pub(crate) id: String,
    pub(crate) kind: SystemEventKind,
    pub(crate) channel: String,
    pub(crate) message: String,
    pub(crate) created_at: u64,
    pub(crate) attempts: u32,
    pub(crate) last_error: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SystemEventStore {
    events: Vec<SystemEvent>,
}

pub(crate) async fn run(args: SystemEventArgs) -> Result<()> {
    match args.command {
        SystemEventCommand::Enqueue(args) => {
            let message = args.message.join(" ");
            let event = enqueue_event(
                if args.direct {
                    SystemEventKind::DirectNotification
                } else {
                    SystemEventKind::AgentPrompt
                },
                args.channel,
                message,
            )
            .await?;
            serde_json::to_writer_pretty(std::io::stdout(), &event)?;
            println!();
        }
        SystemEventCommand::List(args) => {
            let store = SystemEventStore::load().await?;
            if args.json {
                serde_json::to_writer_pretty(std::io::stdout(), &store.events)?;
                println!();
            } else if store.events.is_empty() {
                println!("No queued Anya system events.");
            } else {
                for event in store.events {
                    println!(
                        "{} {:?} {} attempts={} {}",
                        event.id, event.kind, event.channel, event.attempts, event.message
                    );
                }
            }
        }
        SystemEventCommand::Drain(args) => drain_pending_events(&args.endpoint).await?,
    }
    Ok(())
}

pub(crate) async fn enqueue_direct_notification(
    channel: String,
    message: String,
) -> Result<SystemEvent> {
    enqueue_event(SystemEventKind::DirectNotification, channel, message).await
}

pub(crate) fn spawn_startup_dispatcher(endpoint: String) -> JoinHandle<()> {
    tokio::spawn(async move {
        if let Err(error) = drain_startup_events(endpoint).await {
            eprintln!("Anya system event dispatcher stopped: {error:#}");
        }
    })
}

async fn enqueue_event(
    kind: SystemEventKind,
    channel: String,
    message: String,
) -> Result<SystemEvent> {
    if channel.trim().is_empty() {
        anyhow::bail!("--channel must not be empty");
    }
    if message.trim().is_empty() {
        anyhow::bail!("message must not be empty");
    }

    let mut store = SystemEventStore::load().await?;
    let event = SystemEvent {
        id: new_event_id()?,
        kind,
        channel,
        message,
        created_at: unix_timestamp_secs()?,
        attempts: 0,
        last_error: None,
    };
    store.events.push(event.clone());
    store.save().await?;
    Ok(event)
}

async fn drain_startup_events(endpoint: String) -> Result<()> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(STARTUP_DRAIN_TIMEOUT_SECS);
    loop {
        let store = SystemEventStore::load().await?;
        if store.events.is_empty() {
            return Ok(());
        }

        match drain_pending_events(&endpoint).await {
            Ok(()) => return Ok(()),
            Err(error) if tokio::time::Instant::now() < deadline => {
                eprintln!("Anya system event drain retrying: {error:#}");
                tokio::time::sleep(Duration::from_secs(STARTUP_DRAIN_RETRY_SECS)).await;
            }
            Err(error) => return Err(error),
        }
    }
}

async fn drain_pending_events(endpoint: &str) -> Result<()> {
    let events = SystemEventStore::load().await?.events;
    for event in events {
        match dispatch_event(endpoint, &event).await {
            Ok(()) => remove_event(&event.id).await?,
            Err(error) => {
                mark_attempt(&event.id, Some(error.to_string())).await?;
                anyhow::bail!("dispatch queued Anya system event {}: {error:#}", event.id);
            }
        }
    }
    Ok(())
}

async fn dispatch_event(endpoint: &str, event: &SystemEvent) -> Result<()> {
    let text = match event.kind {
        SystemEventKind::DirectNotification => event.message.clone(),
        SystemEventKind::AgentPrompt => run_agent_event(endpoint, event).await?,
    };

    let text = text.trim();
    if text.is_empty() {
        return Ok(());
    }

    if let Some(peer) = whatsapp_peer_for_channel(&event.channel) {
        whatsapp::send_text_via_control(peer, text)?;
    } else {
        println!("{text}");
    }
    Ok(())
}

async fn run_agent_event(endpoint: &str, event: &SystemEvent) -> Result<String> {
    let mut client = CodexRpcClient::connect(endpoint).await?;
    let thread_id = ensure_channel_thread(&mut client, &event.channel).await?;
    client
        .thread_resume(thread_id.clone())
        .await
        .with_context(|| format!("resume channel thread {}", event.channel))?;
    client
        .turn_start_collect(
            thread_id,
            system_event_prompt(event),
            Vec::new(),
            /*model*/ None,
            /*effort*/ None,
            /*service_tier*/ None,
        )
        .await
}

async fn ensure_channel_thread(client: &mut CodexRpcClient, channel: &str) -> Result<String> {
    let mut store = ChannelStore::load().await?;
    if let Some(thread_id) = store.resolve(channel) {
        return Ok(thread_id.to_string());
    }
    let response = client
        .thread_start(
            /*model*/ None, /*service_tier*/ None, /*cwd*/ None,
        )
        .await?;
    store.bind(channel.to_string(), response.thread.id.clone());
    store.save().await?;
    Ok(response.thread.id)
}

fn system_event_prompt(event: &SystemEvent) -> String {
    format!(
        "System event context: Anya has restarted or resumed service operation and is processing a persisted system event. \
Channel: {channel}. If this channel is WhatsApp, respond with the exact user-facing WhatsApp message to send. \
If the event asks you to continue work after restart, continue from the saved instruction and summarize what you did.\n\nSystem event:\n{message}",
        channel = event.channel,
        message = event.message
    )
}

fn whatsapp_peer_for_channel(channel: &str) -> Option<&str> {
    channel.strip_prefix("whatsapp:")
}

async fn mark_attempt(id: &str, last_error: Option<String>) -> Result<()> {
    let mut store = SystemEventStore::load().await?;
    if let Some(event) = store.events.iter_mut().find(|event| event.id == id) {
        event.attempts = event.attempts.saturating_add(1);
        event.last_error = last_error;
        store.save().await?;
    }
    Ok(())
}

async fn remove_event(id: &str) -> Result<()> {
    let mut store = SystemEventStore::load().await?;
    store.events.retain(|event| event.id != id);
    store.save().await
}

impl SystemEventStore {
    async fn load() -> Result<Self> {
        let path = store_path()?;
        match tokio::fs::read(&path).await {
            Ok(bytes) => serde_json::from_slice(&bytes).context("read Anya system event store"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(error).with_context(|| format!("open {}", path.display())),
        }
    }

    async fn save(&self) -> Result<()> {
        let path = store_path()?;
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let bytes = serde_json::to_vec_pretty(self)?;
        tokio::fs::write(&path, bytes)
            .await
            .with_context(|| format!("write {}", path.display()))
    }
}

fn store_path() -> Result<PathBuf> {
    let base = dirs::data_dir().context("resolve user data directory")?;
    Ok(base.join("anya").join("system-events.json"))
}

fn new_event_id() -> Result<String> {
    Ok(format!(
        "{}-{}",
        unix_timestamp_millis()?,
        std::process::id()
    ))
}

fn unix_timestamp_millis() -> Result<u128> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("current time is before Unix epoch")?
        .as_millis())
}

fn unix_timestamp_secs() -> Result<u64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("current time is before Unix epoch")?
        .as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_whatsapp_peer_from_channel() {
        assert_eq!(
            Some("123@lid"),
            whatsapp_peer_for_channel("whatsapp:123@lid")
        );
        assert_eq!(None, whatsapp_peer_for_channel("main"));
    }

    #[test]
    fn system_event_prompt_includes_channel_and_message() {
        let event = SystemEvent {
            id: "event-1".to_string(),
            kind: SystemEventKind::AgentPrompt,
            channel: "whatsapp:123@lid".to_string(),
            message: "continue after restart".to_string(),
            created_at: 1,
            attempts: 0,
            last_error: None,
        };

        let prompt = system_event_prompt(&event);

        assert!(prompt.contains("whatsapp:123@lid"));
        assert!(prompt.contains("continue after restart"));
    }
}
