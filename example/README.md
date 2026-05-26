# Example: Basic Server Setup

Bootstraps two Debian-based servers (`web` and `db`) in parallel:

1. **`10-apt-update.sh`** - runs `apt-get update && upgrade`
2. **`20-setup-ssh-keys.sh`** - creates a `deploy` user and installs your public key(s)
3. **`30-install-docker.sh`** - installs Docker CE from the official repository

## Usage

1. Edit `config.json` - replace the IPs with your actual server addresses.
2. Add your SSH public key(s) to `assets/authorized_keys`, one per line.
3. On first run, s.Orchestrator will fetch each server's host key and ask you to confirm it.

```bash
# From the repo root
s-orchestrator -c example/config.json \
               --assets-dir example/assets \
               --scripts-dir example/scripts
```

## Notes

- Scripts run as the `user` defined in `config.json` (default `root`). Docker and SSH key setup both require root.
- The `DEPLOY_USER` env var (`deploy` by default) is set per-server in `config.json` and injected into every script automatically.
- `assets/authorized_keys` is a plain text file - add one public key per line.
- The sudoers entry added by `20-setup-ssh-keys.sh` grants passwordless sudo to the deploy user. Remove that block if you don't need it.
