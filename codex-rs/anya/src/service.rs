use anyhow::Context;
use anyhow::Result;
use tokio::io::AsyncWriteExt;

use crate::ServiceUnitArgs;

pub fn systemd_unit(args: &ServiceUnitArgs) -> String {
    let mut unit = String::new();
    unit.push_str("[Unit]\n");
    unit.push_str("Description=Anya agent service\n");
    unit.push_str("After=network-online.target\n");
    unit.push_str("Wants=network-online.target\n\n");
    unit.push_str("[Service]\n");
    unit.push_str("Type=simple\n");
    if let Some(user) = &args.user {
        unit.push_str(&format!("User={user}\n"));
    }
    if let Some(working_directory) = &args.working_directory {
        unit.push_str(&format!(
            "WorkingDirectory={}\n",
            working_directory.display()
        ));
    }
    unit.push_str("Restart=on-failure\n");
    unit.push_str("RestartSec=2s\n");
    unit.push_str(&format!(
        "ExecStart={} serve --listen {}\n",
        args.binary.display(),
        args.listen
    ));
    unit.push_str("\n[Install]\n");
    unit.push_str("WantedBy=multi-user.target\n");
    unit
}

pub async fn install_systemd_unit(args: &ServiceUnitArgs) -> Result<()> {
    let path = args.systemd_dir.join(format!("{}.service", args.name));
    let unit = systemd_unit(args);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let mut file = tokio::fs::File::create(&path)
        .await
        .with_context(|| format!("create {}", path.display()))?;
    file.write_all(unit.as_bytes())
        .await
        .with_context(|| format!("write {}", path.display()))?;
    println!("{}", path.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn systemd_unit_runs_embedded_anya_binary() {
        let args = ServiceUnitArgs {
            name: "anya".to_string(),
            binary: PathBuf::from("/opt/anya/bin/anya"),
            listen: "ws://127.0.0.1:4827".to_string(),
            systemd_dir: PathBuf::from("/etc/systemd/system"),
            user: Some("anya".to_string()),
            working_directory: Some(PathBuf::from("/srv/anya")),
        };

        let unit = systemd_unit(&args);

        assert_eq!(
            unit,
            concat!(
                "[Unit]\n",
                "Description=Anya agent service\n",
                "After=network-online.target\n",
                "Wants=network-online.target\n\n",
                "[Service]\n",
                "Type=simple\n",
                "User=anya\n",
                "WorkingDirectory=/srv/anya\n",
                "Restart=on-failure\n",
                "RestartSec=2s\n",
                "ExecStart=/opt/anya/bin/anya serve --listen ws://127.0.0.1:4827\n",
                "\n",
                "[Install]\n",
                "WantedBy=multi-user.target\n",
            )
        );
    }
}
