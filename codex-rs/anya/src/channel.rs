use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::Context;
use anyhow::Result;
use serde::Deserialize;
use serde::Serialize;

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ChannelStore {
    channels: BTreeMap<String, String>,
}

impl ChannelStore {
    pub async fn load() -> Result<Self> {
        let path = store_path()?;
        match tokio::fs::read(&path).await {
            Ok(bytes) => serde_json::from_slice(&bytes).context("read channel store"),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(err) => Err(err).with_context(|| format!("open {}", path.display())),
        }
    }

    pub async fn save(&self) -> Result<()> {
        let path = store_path()?;
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let bytes = serde_json::to_vec_pretty(self)?;
        tokio::fs::write(&path, bytes)
            .await
            .with_context(|| format!("write {}", path.display()))
    }

    pub fn bind(&mut self, name: String, thread_id: String) {
        self.channels.insert(name, thread_id);
    }

    pub fn resolve(&self, name: &str) -> Option<&str> {
        self.channels.get(name).map(String::as_str)
    }

    pub fn channels(&self) -> &BTreeMap<String, String> {
        &self.channels
    }
}

fn store_path() -> Result<PathBuf> {
    let base = dirs::data_dir().context("resolve user data directory")?;
    Ok(base.join("anya").join("channels.json"))
}
