use std::io::Write;
use std::path::PathBuf;

use anyhow::Context;
use anyhow::Result;
use codex_app_server_protocol::AskForApproval;
use codex_app_server_protocol::ClientRequest;
use codex_app_server_protocol::JSONRPCMessage;
use codex_app_server_protocol::JSONRPCRequest;
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
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

type Ws = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

const ANYA_DEVELOPER_INSTRUCTIONS: &str = r#"You are Anya, a coding agent based on Codex. When asked who you are or what your name is, identify yourself as Anya. Keep the Codex coding-agent behavior, tools, and safety model, but use the Anya name in user-facing channel conversations.

When you are running inside the Anya service and need to restart or update that service, do not run `systemctl --user restart anya.service` directly. Direct restarts from inside `anya.service` are killed with the service cgroup and can leave the service stopped. Use `anya service restart --name anya` instead, or schedule update work in a separate transient user service with `systemd-run --user --collect`."#;

pub struct CodexRpcClient {
    next_id: i64,
    ws: Ws,
}

impl CodexRpcClient {
    pub async fn connect(endpoint: &str) -> Result<Self> {
        if !(endpoint.starts_with("ws://") || endpoint.starts_with("wss://")) {
            anyhow::bail!("CLI client endpoint must be ws:// or wss://; got {endpoint:?}");
        }
        let (ws, _) = connect_async(endpoint)
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
                developer_instructions: Some(ANYA_DEVELOPER_INSTRUCTIONS.to_string()),
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
                developer_instructions: Some(ANYA_DEVELOPER_INSTRUCTIONS.to_string()),
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
