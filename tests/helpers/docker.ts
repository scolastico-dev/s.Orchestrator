import { execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { randomBytes } from 'crypto';
import Dockerode from 'dockerode';

const docker = new Dockerode();

export const SSHD_IMAGE_TAG = 's-orchestrator-test-sshd:latest';
const FIXTURES_DIR = resolve(__dirname, '../fixtures/sshd');

export function isDockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export async function buildSshdImage(): Promise<void> {
  // Check if already built
  const images = await docker.listImages({ filters: { reference: [SSHD_IMAGE_TAG] } });
  if (images.length > 0) return;

  await new Promise<void>((resolve, reject) => {
    docker.buildImage(
      { context: FIXTURES_DIR, src: ['Dockerfile', 'entrypoint.sh'] },
      { t: SSHD_IMAGE_TAG },
      (err, stream) => {
        if (err || !stream) return reject(err ?? new Error('No build stream'));
        docker.modem.followProgress(stream, (buildErr) => {
          if (buildErr) reject(buildErr);
          else resolve();
        });
      }
    );
  });
}

export interface TempKeyPair {
  privateKeyPath: string;
  publicKey: string;
  cleanup: () => void;
}

export function generateTempKeyPair(): TempKeyPair {
  const id = randomBytes(6).toString('hex');
  const dir = join(tmpdir(), `s-orch-test-keys-${id}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const privateKeyPath = join(dir, 'id_rsa');

  const result = spawnSync('ssh-keygen', [
    '-t', 'rsa',
    '-b', '2048',
    '-f', privateKeyPath,
    '-N', '',
    '-q',
  ]);

  if (result.status !== 0) {
    throw new Error(`ssh-keygen failed: ${result.stderr?.toString()}`);
  }

  const publicKey = readFileSync(`${privateKeyPath}.pub`, 'utf8').trim();

  return {
    privateKeyPath,
    publicKey,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

export interface TestSshContainer {
  host: string;
  port: number;
  user: string;
  privateKeyPath: string;
  /** Temp known_hosts file pre-loaded with all of the container's host keys */
  knownHostsPath: string;
  /** Return all SSH host keys from the container as "keytype base64" strings */
  getHostKeys(): Promise<string[]>;
  /** Stop and remove the container, clean up temp files */
  cleanup(): Promise<void>;
}

async function waitForSsh(
  host: string,
  port: number,
  privateKeyPath: string,
  maxWaitMs = 30_000
): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const child = spawnSync('ssh', [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=2',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'LogLevel=error',
      '-i', privateKeyPath,
      '-p', port.toString(),
      `root@${host}`,
      'exit',
    ]);
    if (child.status === 0) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`SSH server at ${host}:${port} did not become ready in time`);
}

export async function startTestSshContainer(): Promise<TestSshContainer> {
  await buildSshdImage();

  const keys = generateTempKeyPair();

  const container = await docker.createContainer({
    Image: SSHD_IMAGE_TAG,
    Env: [`SSH_AUTHORIZED_KEY=${keys.publicKey}`],
    ExposedPorts: { '22/tcp': {} },
    HostConfig: {
      PortBindings: { '22/tcp': [{ HostPort: '0' }] },
      AutoRemove: false,
    },
  });

  await container.start();

  const info = await container.inspect();
  const portBinding = info.NetworkSettings.Ports['22/tcp'];
  if (!portBinding || portBinding.length === 0) {
    await container.stop();
    await container.remove();
    keys.cleanup();
    throw new Error('Container did not bind SSH port');
  }

  const port = parseInt(portBinding[0].HostPort, 10);
  const host = '127.0.0.1';

  await waitForSsh(host, port, keys.privateKeyPath);

  // Scan the container's host key and write a temporary known_hosts file so
  // tests can use StrictHostKeyChecking=yes without touching ~/.ssh/known_hosts.
  const keyscanResult = spawnSync('ssh-keyscan', ['-p', port.toString(), host], {
    encoding: 'utf8',
  });
  const knownHostsPath = join(tmpdir(), `s-orch-known-hosts-${randomBytes(6).toString('hex')}`);
  writeFileSync(knownHostsPath, keyscanResult.stdout ?? '', { mode: 0o600 });

  function getHostKeys(): Promise<string[]> {
    const lines = (keyscanResult.stdout ?? '')
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('#'));
    if (lines.length === 0) throw new Error('Could not scan host keys from container');
    const result: string[] = [];
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const keyStr = parts.pop()!;
      const keyType = parts.pop()!;
      if (keyStr && keyType) result.push(`${keyType} ${keyStr}`);
    }
    return Promise.resolve(result);
  }

  return {
    host,
    port,
    user: 'root',
    privateKeyPath: keys.privateKeyPath,
    knownHostsPath,
    getHostKeys,
    async cleanup() {
      try {
        await container.stop({ t: 5 });
      } catch {
        // already stopped
      }
      try {
        await container.remove();
      } catch {
        // already removed
      }
      keys.cleanup();
      try {
        if (existsSync(knownHostsPath)) rmSync(knownHostsPath);
      } catch {
        // best-effort
      }
    },
  };
}

export function writeTempFile(content: string, suffix = '.json'): { path: string; cleanup: () => void } {
  const id = randomBytes(6).toString('hex');
  const filePath = join(tmpdir(), `s-orch-test-${id}${suffix}`);
  writeFileSync(filePath, content, 'utf8');
  return {
    path: filePath,
    cleanup: () => {
      try {
        if (existsSync(filePath)) rmSync(filePath);
      } catch {
        // best-effort
      }
    },
  };
}
