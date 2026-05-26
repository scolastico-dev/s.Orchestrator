#!/bin/sh
set -e

if [ -n "$SSH_AUTHORIZED_KEY" ]; then
  echo "$SSH_AUTHORIZED_KEY" > /root/.ssh/authorized_keys
  chmod 600 /root/.ssh/authorized_keys
fi

exec /usr/sbin/sshd -D -e "$@"
