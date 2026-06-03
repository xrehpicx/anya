use std::io::Write;
use std::path::PathBuf;

use anyhow::Context;
use anyhow::Result;
use codex_app_server_protocol::AskForApproval;
use codex_app_server_protocol::ClientRequest;
use codex_app_server_protocol::JSONRPCMessage;
use codex_app_server_protocol::JSONRPCRequest;
use codex_app_server_protocol::ModelListParams;
use codex_app_server_protocol::ModelListResponse;
use codex_app_server_protocol::RequestId;
use codex_app_server_protocol::SandboxMode;
use codex_app_server_protocol::ServerNotification;
use codex_app_server_protocol::ThreadResumeParams;
use codex_app_server_protocol::ThreadResumeResponse;
use codex_app_server_protocol::ThreadStartParams;
use codex_app_server_protocol::ThreadStartResponse;
use codex_app_server_protocol::TurnStartParams;
use codex_app_server_protocol::TurnStartResponse;
use codex_app_server_protocol::TurnSteerParams;
use codex_app_server_protocol::TurnSteerResponse;
use codex_app_server_protocol::UserInput;
use codex_protocol::openai_models::ReasoningEffort;
use futures::SinkExt;
use futures::StreamExt;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio_tungstenite::MaybeTlsStream;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::connect_async_with_config;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

type Ws = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

// Match Codex's remote app-server client. Large completed items can arrive
// before normal context compaction has a chance to run.
const ANYA_APP_SERVER_MAX_WEBSOCKET_MESSAGE_SIZE: usize = 128 << 20;

const ANYA_DEVELOPER_INSTRUCTIONS: &str = r#"You are Anya, a coding agent based on Codex. When asked who you are or what your name is, identify yourself as Anya. Keep the Codex coding-agent behavior, tools, and safety model, but use the Anya name in user-facing channel conversations.

When you are running inside the Anya service and need to restart or update that service, do not run `systemctl --user restart anya.service` directly. Direct restarts from inside `anya.service` are killed with the service cgroup and can leave the service stopped. Use `anya service restart --name anya` instead, or schedule update work in a separate transient user service with `systemd-run --user --collect`.

If the user expects a notification or follow-up after Anya restarts or updates itself, queue a persisted system event before restarting. Use `anya system-event enqueue --channel "<channel>" "instruction to continue after restart"` for agent follow-up, or `anya system-event enqueue --channel "<channel>" --direct "Anya restarted."` for direct notification. For self-updates, prefer `anya update --notify-channel "<channel>"` when a simple update-completed notification is enough."#;

const ANYA_WHATSAPP_CHANNEL_INSTRUCTIONS: &str = r#"When speaking through WhatsApp, users can change Anya channel settings with slash commands. Use `/models` to list available model IDs, `/model <model-id>` to set the current WhatsApp channel model, `/model default` to clear it, `/thinking <none|minimal|low|medium|high|xhigh>` to set reasoning effort, and `/thinking default` to clear it. If a user asks to change model or thinking level from WhatsApp, tell them the exact command to send instead of editing config files by hand."#;

const ANYA_SETUP_INSTRUCTIONS: &str = r#"When a user asks whether Anya setup is done, asks to configure Anya, starts a new channel and appears to be initiating setup, or asks what Anya's default working directory is, run `anya setup status --json` before answering. Treat first-run setup as distinct from service health: `anya.service` running, auth passing, and WhatsApp connected do not mean setup is complete. If setup is incomplete, use the `anya-setup` skill, ask one missing setup question at a time, and persist confirmed answers with `anya setup set --default-workdir ... --self-iteration-file ... --confirm`. Do not claim setup is complete without checking this command.

When the user asks about Anya's own CLI, config files, config validation, or applying config, use the `anya-cli` skill. Anya's nginx-style config workflow is `anya config check --json` before `anya config apply --json`."#;

fn anya_developer_instructions() -> String {
    format!(
        "{ANYA_DEVELOPER_INSTRUCTIONS}\n\n{ANYA_WHATSAPP_CHANNEL_INSTRUCTIONS}\n\n{ANYA_SETUP_INSTRUCTIONS}"
    )
}

pub struct CodexRpcClient {
    next_id: i64,
    ws: Ws,
}

#[derive(Debug, Clone, Copy)]
pub enum ModelVisibility {
    Default,
    IncludeHidden,
}

impl CodexRpcClient {
    pub async fn connect(endpoint: &str) -> Result<Self> {
        if !(endpoint.starts_with("ws://") || endpoint.starts_with("wss://")) {
            anyhow::bail!("CLI client endpoint must be ws:// or wss://; got {endpoint:?}");
        }
        let (ws, _) = connect_async_with_config(
            endpoint,
            Some(anya_app_server_websocket_config()),
            /*disable_nagle*/ false,
        )
        .await
        .with_context(|| format!("connect to Codex app-server at {endpoint}"))?;
        let mut client = Self { next_id: 1, ws };
        client.initialize().await?;
        Ok(client)
    }

    pub async fn thread_start(
        &mut self,
        model: Option<String>,
        cwd: Option<String>,
    ) -> Result<ThreadStartResponse> {
        let request_id = self.request_id();
        self.request_typed(ClientRequest::ThreadStart {
            request_id,
            params: ThreadStartParams {
                model,
                cwd,
                approval_policy: Some(AskForApproval::Never),
                sandbox: Some(SandboxMode::DangerFullAccess),
                developer_instructions: Some(anya_developer_instructions()),
                ..ThreadStartParams::default()
            },
        })
        .await
    }

    pub async fn thread_resume(&mut self, thread_id: String) -> Result<ThreadResumeResponse> {
        let request_id = self.request_id();
        self.request_typed(ClientRequest::ThreadResume {
            request_id,
            params: ThreadResumeParams {
                thread_id,
                approval_policy: Some(AskForApproval::Never),
                sandbox: Some(SandboxMode::DangerFullAccess),
                developer_instructions: Some(anya_developer_instructions()),
                ..ThreadResumeParams::default()
            },
        })
        .await
    }

    pub async fn turn_start(
        &mut self,
        thread_id: String,
        text: String,
        images: Vec<PathBuf>,
        model: Option<String>,
        effort: Option<ReasoningEffort>,
    ) -> Result<TurnStartResponse> {
        let request_id = self.request_id();
        self.request_typed(ClientRequest::TurnStart {
            request_id,
            params: TurnStartParams {
                thread_id,
                input: turn_input(text, images),
                model,
                effort,
                ..TurnStartParams::default()
            },
        })
        .await
    }

    pub async fn turn_steer(
        &mut self,
        thread_id: String,
        expected_turn_id: String,
        text: String,
        images: Vec<PathBuf>,
    ) -> Result<TurnSteerResponse> {
        let request_id = self.request_id();
        self.request_typed(ClientRequest::TurnSteer {
            request_id,
            params: TurnSteerParams {
                thread_id,
                input: turn_input(text, images),
                expected_turn_id,
                ..TurnSteerParams::default()
            },
        })
        .await
    }

    pub async fn model_list(&mut self, visibility: ModelVisibility) -> Result<ModelListResponse> {
        let request_id = self.request_id();
        self.request_typed(ClientRequest::ModelList {
            request_id,
            params: ModelListParams {
                include_hidden: Some(matches!(visibility, ModelVisibility::IncludeHidden)),
                ..ModelListParams::default()
            },
        })
        .await
    }

    pub async fn turn_start_streaming(
        &mut self,
        thread_id: String,
        text: String,
        images: Vec<PathBuf>,
    ) -> Result<()> {
        let response = self
            .turn_start_collect(thread_id, text, images, None, None)
            .await?;
        let mut stdout = std::io::stdout().lock();
        stdout.write_all(response.as_bytes())?;
        writeln!(stdout)?;
        Ok(())
    }

    pub async fn turn_start_json_stream(
        &mut self,
        thread_id: String,
        text: String,
        images: Vec<PathBuf>,
        model: Option<String>,
        effort: Option<ReasoningEffort>,
    ) -> Result<()> {
        let request_id = self.request_id();
        let request = ClientRequest::TurnStart {
            request_id: request_id.clone(),
            params: TurnStartParams {
                thread_id: thread_id.clone(),
                input: turn_input(text, images),
                model,
                effort,
                ..TurnStartParams::default()
            },
        };
        let method = request.method();
        let value = serde_json::to_value(request).context("serialize Codex request")?;
        self.ws
            .send(Message::Text(value.to_string().into()))
            .await
            .with_context(|| format!("send {method} request"))?;

        let mut stdout = std::io::stdout().lock();
        let mut saw_response = false;
        let mut saw_completion = false;
        while let Some(message) = self.ws.next().await {
            let message = message.context("read websocket message")?;
            let Some(rpc_message) = decode_ws_message(message)? else {
                continue;
            };

            match rpc_message {
                JSONRPCMessage::Response(response) if response.id == request_id => {
                    saw_response = true;
                    let response = serde_json::from_value::<TurnStartResponse>(response.result)
                        .context("decode turn/start response")?;
                    write_json_stream_event(
                        &mut stdout,
                        serde_json::json!({
                            "type": "turn_accepted",
                            "turn_id": response.turn.id,
                        }),
                    )?;
                    if saw_completion {
                        break;
                    }
                }
                JSONRPCMessage::Error(error) if error.id == request_id => {
                    anyhow::bail!(
                        "{method} failed: {} (code {})",
                        error.error.message,
                        error.error.code
                    );
                }
                JSONRPCMessage::Notification(notification) => {
                    let notification = ServerNotification::try_from(notification)
                        .context("decode server notification")?;
                    match notification {
                        ServerNotification::AgentMessageDelta(delta)
                            if delta.thread_id == thread_id =>
                        {
                            write_json_stream_event(
                                &mut stdout,
                                serde_json::json!({
                                    "type": "message_delta",
                                    "delta": delta.delta,
                                }),
                            )?;
                        }
                        ServerNotification::TurnCompleted(done) if done.thread_id == thread_id => {
                            saw_completion = true;
                            write_json_stream_event(
                                &mut stdout,
                                serde_json::json!({ "type": "turn_completed" }),
                            )?;
                            if saw_response {
                                break;
                            }
                        }
                        _ => {
                            write_json_stream_event(
                                &mut stdout,
                                serde_json::json!({ "type": "activity" }),
                            )?;
                        }
                    }
                }
                _ => {}
            }
        }

        if saw_response && saw_completion {
            Ok(())
        } else {
            anyhow::bail!("websocket closed before turn completed")
        }
    }

    pub async fn turn_start_collect(
        &mut self,
        thread_id: String,
        text: String,
        images: Vec<PathBuf>,
        model: Option<String>,
        effort: Option<ReasoningEffort>,
    ) -> Result<String> {
        let request_id = self.request_id();
        let request = ClientRequest::TurnStart {
            request_id: request_id.clone(),
            params: TurnStartParams {
                thread_id: thread_id.clone(),
                input: turn_input(text, images),
                model,
                effort,
                ..TurnStartParams::default()
            },
        };
        let method = request.method();
        let value = serde_json::to_value(request).context("serialize Codex request")?;
        self.ws
            .send(Message::Text(value.to_string().into()))
            .await
            .with_context(|| format!("send {method} request"))?;

        let mut saw_response = false;
        let mut saw_completion = false;
        let mut response = String::new();
        while let Some(message) = self.ws.next().await {
            let message = message.context("read websocket message")?;
            let Some(rpc_message) = decode_ws_message(message)? else {
                continue;
            };

            match rpc_message {
                JSONRPCMessage::Response(response) if response.id == request_id => {
                    saw_response = true;
                    if saw_completion {
                        break;
                    }
                }
                JSONRPCMessage::Error(error) if error.id == request_id => {
                    anyhow::bail!(
                        "{method} failed: {} (code {})",
                        error.error.message,
                        error.error.code
                    );
                }
                JSONRPCMessage::Notification(notification) => {
                    let notification = ServerNotification::try_from(notification)
                        .context("decode server notification")?;
                    match notification {
                        ServerNotification::AgentMessageDelta(delta)
                            if delta.thread_id == thread_id =>
                        {
                            response.push_str(&delta.delta);
                        }
                        ServerNotification::TurnCompleted(done) if done.thread_id == thread_id => {
                            saw_completion = true;
                            if saw_response {
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }

        if saw_response && saw_completion {
            Ok(response)
        } else {
            anyhow::bail!("websocket closed before turn completed")
        }
    }

    pub async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        let request = serde_json::from_value::<ClientRequest>(serde_json::json!({
            "method": method,
            "id": self.request_id(),
            "params": params
        }))
        .with_context(|| format!("build typed Codex request for {method}"))?;
        self.request_value(request).await
    }

    async fn request_typed<T>(&mut self, request: ClientRequest) -> Result<T>
    where
        T: DeserializeOwned,
    {
        let method = request.method();
        let value = self.request_value(request).await?;
        serde_json::from_value(value).with_context(|| format!("decode {method} response"))
    }

    async fn request_value(&mut self, request: ClientRequest) -> Result<Value> {
        let method = request.method();
        let request_id = request.id().clone();
        let value = serde_json::to_value(request).context("serialize Codex request")?;
        self.ws
            .send(Message::Text(value.to_string().into()))
            .await
            .with_context(|| format!("send {method} request"))?;

        while let Some(message) = self.ws.next().await {
            let message = message.context("read websocket message")?;
            let Some(rpc_message) = decode_ws_message(message)? else {
                continue;
            };
            match rpc_message {
                JSONRPCMessage::Response(response) if response.id == request_id => {
                    return Ok(response.result);
                }
                JSONRPCMessage::Error(error) if error.id == request_id => {
                    anyhow::bail!(
                        "{method} failed: {} (code {})",
                        error.error.message,
                        error.error.code
                    );
                }
                _ => continue,
            }
        }
        anyhow::bail!("websocket closed before {method} response")
    }

    async fn initialize(&mut self) -> Result<()> {
        let request_id = self.request_id();
        let request = JSONRPCRequest {
            id: request_id.clone(),
            method: "initialize".to_string(),
            params: Some(serde_json::json!({
                "clientInfo": {
                    "name": "anya",
                    "title": "Anya",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "capabilities": {
                    "experimentalApi": true
                }
            })),
            trace: None,
        };
        self.ws
            .send(Message::Text(serde_json::to_string(&request)?.into()))
            .await
            .context("send initialize request")?;
        while let Some(message) = self.ws.next().await {
            let message = message.context("read initialize response")?;
            let Some(rpc_message) = decode_ws_message(message)? else {
                continue;
            };
            match rpc_message {
                JSONRPCMessage::Response(response) if response.id == request_id => return Ok(()),
                JSONRPCMessage::Error(error) if error.id == request_id => {
                    anyhow::bail!(
                        "initialize failed: {} (code {})",
                        error.error.message,
                        error.error.code
                    );
                }
                _ => continue,
            }
        }
        anyhow::bail!("websocket closed before initialize response")
    }

    fn request_id(&mut self) -> RequestId {
        let id = self.next_id;
        self.next_id += 1;
        RequestId::Integer(id)
    }
}

fn anya_app_server_websocket_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_frame_size(Some(ANYA_APP_SERVER_MAX_WEBSOCKET_MESSAGE_SIZE))
        .max_message_size(Some(ANYA_APP_SERVER_MAX_WEBSOCKET_MESSAGE_SIZE))
}

fn turn_input(text: String, images: Vec<PathBuf>) -> Vec<UserInput> {
    let mut input = images
        .into_iter()
        .map(|path| UserInput::LocalImage { path, detail: None })
        .collect::<Vec<_>>();
    input.push(UserInput::Text {
        text,
        text_elements: Vec::new(),
    });
    input
}

fn write_json_stream_event(
    writer: &mut impl Write,
    value: serde_json::Value,
) -> std::io::Result<()> {
    serde_json::to_writer(&mut *writer, &value)?;
    writeln!(writer)?;
    writer.flush()
}

fn decode_ws_message(message: Message) -> Result<Option<JSONRPCMessage>> {
    let text = match message {
        Message::Text(text) => text.to_string(),
        Message::Binary(bytes) => {
            String::from_utf8(bytes.to_vec()).context("decode binary websocket message")?
        }
        Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => return Ok(None),
        Message::Close(frame) => anyhow::bail!("app-server closed websocket: {frame:?}"),
    };
    serde_json::from_str::<JSONRPCMessage>(&text)
        .context("decode JSON-RPC message")
        .map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_server_websocket_limit_matches_codex_remote_client() {
        assert_eq!(128 << 20, ANYA_APP_SERVER_MAX_WEBSOCKET_MESSAGE_SIZE);
    }
}
