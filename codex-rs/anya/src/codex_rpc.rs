use std::io::Write;

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
use codex_app_server_protocol::UserInput;
use futures::SinkExt;
use futures::StreamExt;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio_tungstenite::MaybeTlsStream;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

type Ws = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

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
                history: None,
                path: None,
                model: None,
                model_provider: None,
                service_tier: None,
                cwd: None,
                runtime_workspace_roots: None,
                approval_policy: Some(AskForApproval::Never),
                approvals_reviewer: None,
                sandbox: Some(SandboxMode::DangerFullAccess),
                permissions: None,
                config: None,
                base_instructions: None,
                developer_instructions: None,
                personality: None,
                exclude_turns: false,
                persist_extended_history: false,
            },
        })
        .await
    }

    pub async fn turn_start(
        &mut self,
        thread_id: String,
        text: String,
    ) -> Result<TurnStartResponse> {
        let request_id = self.request_id();
        self.request_typed(ClientRequest::TurnStart {
            request_id,
            params: TurnStartParams {
                thread_id,
                input: vec![UserInput::Text {
                    text,
                    text_elements: Vec::new(),
                }],
                ..TurnStartParams::default()
            },
        })
        .await
    }

    pub async fn turn_start_streaming(&mut self, thread_id: String, text: String) -> Result<()> {
        let response = self.turn_start_collect(thread_id, text).await?;
        let mut stdout = std::io::stdout().lock();
        stdout.write_all(response.as_bytes())?;
        writeln!(stdout)?;
        Ok(())
    }

    pub async fn turn_start_collect(&mut self, thread_id: String, text: String) -> Result<String> {
        let request_id = self.request_id();
        let request = ClientRequest::TurnStart {
            request_id: request_id.clone(),
            params: TurnStartParams {
                thread_id: thread_id.clone(),
                input: vec![UserInput::Text {
                    text,
                    text_elements: Vec::new(),
                }],
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
