# Publishing Anya

This repo publishes Anya updates through GitHub release assets. `anya update`
downloads the installer from `main`, then installs
`https://github.com/xrehpicx/anya/releases/latest/download/anya-<target>.tar.gz`.

## Local Checks

From `codex-rs`:

```shell
cargo fmt -- --config imports_granularity=Item
just test -p codex-anya
just fix -p codex-anya
```

If Rust dependencies changed, also run these from the repo root:

```shell
just bazel-lock-update
just bazel-lock-check
```

## Commit And Push

```shell
git status --short
git add <changed-files>
git commit -m "<message>"
git push origin main
```

Confirm GitHub Actions is green before refreshing the release asset:

```shell
gh run list --repo xrehpicx/anya --branch main --limit 5
```

## Build And Upload The Linux Asset

On `imai`, build from the pushed `main` branch:

```shell
cd /home/raj/anya/projects/anya
git fetch origin main
git reset --hard origin/main
cd codex-rs
. "$HOME/.cargo/env"
cargo build --release -p codex-anya
install -m 0755 target/release/anya "$HOME/.local/bin/anya"
"$HOME/.local/bin/anya" whatsapp install --skip-npm-install
node --check "$HOME/.local/share/anya/whatsapp/bridge.mjs"
"$HOME/.local/bin/anya" service restart --name anya
```

Package and upload the asset used by the installer and `anya update`:

```shell
tmp="$(mktemp -d)"
install -m 0755 "$HOME/.local/bin/anya" "$tmp/anya"
tar -C "$tmp" -czf /tmp/anya-x86_64-unknown-linux-gnu.tar.gz anya
gh release upload anya-v0.1.0 /tmp/anya-x86_64-unknown-linux-gnu.tar.gz \
  --repo xrehpicx/anya \
  --clobber
rm -rf "$tmp"
```

The current release setup uses `anya-v0.1.0` as the latest mutable tag. If a new
tag is created later, make that tag the latest GitHub release before expecting
plain `anya update` to pick it up.

## Smoke Test The Published Update

```shell
anya update --no-restart-service
anya auth status --timeout-secs 60
systemctl --user is-active anya.service
```

Run `anya update` without `--no-restart-service` when you want the installed user
service to restart onto the refreshed binary.
