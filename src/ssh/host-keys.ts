import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { OrchestratorConfig, ServerConfig } from '../config';
import type { ConfirmFn } from '../ui/types';
import { execPromise } from './executor';

const knownHostsPath = join(homedir(), '.ssh', 'known_hosts');

function ensureKnownHostsFile(): void {
  const sshDir = join(homedir(), '.ssh');
  if (!existsSync(sshDir)) mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  if (!existsSync(knownHostsPath)) writeFileSync(knownHostsPath, '', { mode: 0o600 });
}

/** Returns all host key types offered by the server as "keytype base64" strings. */
export async function fetchHostKeys(ip: string, port: number): Promise<string[]> {
  const res = await execPromise(`ssh-keyscan -p ${port} ${ip} 2>/dev/null`);
  const lines = res.stdout.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  const keys: string[] = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    const keyStr = parts.pop();
    const keyType = parts.pop();
    if (keyStr && keyType) keys.push(`${keyType} ${keyStr}`);
  }
  return keys;
}

export interface HostKeyEnforcementResult {
  configChanged: boolean;
  mismatches: string[];
}

export async function enforceHostKeys(
  config: OrchestratorConfig,
  confirmFn: ConfirmFn,
  dryRun: boolean
): Promise<HostKeyEnforcementResult> {
  ensureKnownHostsFile();
  let configChanged = false;

  // Phase 1: confirm any new (unknown) host keys before checking for mismatches,
  // so confirmed keys are persisted even when mismatches are found later.
  for (const [name, data] of Object.entries(config)) {
    if (data.hostKeys && data.hostKeys.length > 0) continue;

    const ip = data.ip;
    const port = data.port ?? 22;
    const keys = await fetchHostKeys(ip, port);

    if (keys.length === 0) {
      throw new Error(
        `Could not fetch host keys for "${name}" (${ip}:${port}). Is the server reachable?`
      );
    }

    const [firstType, firstData] = keys[0].split(' ');
    const preview = firstData.substring(0, 30);
    const msg =
      `Server: ${name} (${ip}:${port})\n\n` +
      `Found ${keys.length} key type(s):\n  ${firstType} ${preview}...\n\n` +
      `Save these host keys to the config file?`;

    const ok = await confirmFn(msg, 'NEW HOST KEYS DETECTED', 'blue');
    if (!ok) throw new Error('Deployment aborted: user declined to save host keys.');

    if (!dryRun) {
      (data as ServerConfig & { hostKeys: string[] }).hostKeys = keys;
      configChanged = true;
    }
  }

  // Phase 2: check all servers for known_hosts mismatches and collect them all
  // before surfacing any error, so every mismatch is reported in one run.
  const mismatches: string[] = [];

  for (const [name, data] of Object.entries(config)) {
    const ip = data.ip;
    const port = data.port ?? 22;

    // Use the correct lookup format: [ip]:port for non-standard ports.
    const sshHost = port === 22 ? ip : `[${ip}]:${port}`;
    const hostPrefix = sshHost;

    const keygenRes = await execPromise(`ssh-keygen -F "${sshHost}" -f "${knownHostsPath}"`);
    const knownLines =
      keygenRes.code === 0 && keygenRes.stdout.trim()
        ? keygenRes.stdout.split('\n').filter((l) => l.trim() && !l.startsWith('#'))
        : [];

    for (const storedKey of data.hostKeys ?? []) {
      const parts = storedKey.trim().split(/\s+/);
      const justKey = parts[parts.length - 1];
      const keyType = parts[0];

      // Look for this key type among the known_hosts entries for this host.
      const existingEntry = knownLines.find((l) => {
        const p = l.trim().split(/\s+/);
        return p[1] === keyType; // p[0]=host, p[1]=keytype, p[2]=keydata
      });

      if (existingEntry) {
        const existingKey = existingEntry.trim().split(/\s+/).pop() ?? '';
        if (existingKey !== justKey) {
          const fixCmd =
            port === 22
              ? `  ssh-keygen -R ${ip}`
              : `  ssh-keygen -R ${ip}\n  ssh-keygen -R ${sshHost}`;
          mismatches.push(
            `[SECURITY] Host key mismatch for "${name}" (${ip}), key type ${keyType}!\n` +
              `The ${keyType} key in your config does NOT match ${knownHostsPath}.\n` +
              `To fix, remove the conflicting entry:\n${fixCmd}`
          );
        }
        // else: key type exists and matches — nothing to do
      } else if (!dryRun) {
        // Key type not yet in known_hosts — add it.
        appendFileSync(knownHostsPath, `${hostPrefix} ${storedKey}\n`);
      }
    }
  }

  return { configChanged, mismatches };
}
