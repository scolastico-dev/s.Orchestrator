#!/usr/bin/env bash
set -euo pipefail

# Create a non-root deploy user if it doesn't exist yet
if ! id "$DEPLOY_USER" &>/dev/null; then
  useradd -m -s /bin/bash "$DEPLOY_USER"
fi

SSH_DIR="/home/$DEPLOY_USER/.ssh"
mkdir -p "$SSH_DIR"
chmod 700 "$SSH_DIR"

# Install the authorized_keys uploaded via assets/
cp "$ASSET_DIR/authorized_keys" "$SSH_DIR/authorized_keys"
chmod 600 "$SSH_DIR/authorized_keys"
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$SSH_DIR"

# Allow the deploy user to run sudo without a password (optional — remove if not needed)
echo "$DEPLOY_USER ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/$DEPLOY_USER"
chmod 440 "/etc/sudoers.d/$DEPLOY_USER"

echo "SSH key setup complete for user: $DEPLOY_USER"
