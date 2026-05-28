import { exec, spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import type { ExecResult } from '../types';

export class RemoteExitError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null
  ) {
    super(message);
    this.name = 'RemoteExitError';
  }
}

export interface StreamCallbacks {
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  onChild?: (child: ChildProcess) => void;
  onChildExit?: () => void;
}

export interface SshTarget {
  ip: string;
  port: number;
  user: string;
  keyFile?: string;
  /** Override the known_hosts file used for host key verification (useful in tests) */
  knownHostsFile?: string;
}

function buildSshArgs(target: SshTarget, extra: string[]): string[] {
  const args: string[] = [
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'LogLevel=error',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=6',
    '-p', target.port.toString(),
  ];
  if (target.knownHostsFile) {
    args.push('-o', `UserKnownHostsFile=${target.knownHostsFile}`);
  }
  if (target.keyFile) {
    args.push('-i', target.keyFile);
  }
  args.push(...extra);
  return args;
}

export function execPromise(cmd: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    exec(cmd, (error, stdout, stderr) => {
      resolve({
        stdout,
        stderr,
        code: (error as NodeJS.ErrnoException | null)?.code !== undefined
          ? Number((error as NodeJS.ErrnoException).code)
          : error
            ? 1
            : 0,
      });
    });
  });
}

export function execRemoteStreaming(
  target: SshTarget,
  command: string,
  cb: StreamCallbacks = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = buildSshArgs(target, [
      '-tt',
      `${target.user}@${target.ip}`,
      command,
    ]);

    const child = spawn('ssh', args);
    cb.onChild?.(child);

    child.stdout.on('data', (d: Buffer) => cb.onStdout?.(d.toString()));
    child.stderr.on('data', (d: Buffer) => cb.onStderr?.(d.toString()));

    child.on('close', (code) => {
      cb.onChildExit?.();
      if (code === 0) resolve();
      else reject(new RemoteExitError(`Remote command exited with code ${code ?? 'null'}`, code));
    });

    child.on('error', (err) => {
      cb.onChildExit?.();
      reject(err);
    });
  });
}

export function execRemoteSimple(
  target: SshTarget,
  command: string,
  cb: StreamCallbacks = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = buildSshArgs(target, [
      '-o', 'BatchMode=yes',
      `${target.user}@${target.ip}`,
      command,
    ]);

    const child = spawn('ssh', args);
    let out = '';

    child.stdout.on('data', (d: Buffer) => {
      const str = d.toString();
      out += str;
      cb.onStdout?.(str);
    });
    child.stderr.on('data', (d: Buffer) => cb.onStderr?.(d.toString()));

    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new RemoteExitError(`Remote command exited with code ${code ?? 'null'}`, code));
    });

    child.on('error', reject);
  });
}

export function scpUpload(
  target: SshTarget,
  localPath: string,
  remotePath: string,
  cb: StreamCallbacks = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args: string[] = [
      '-o', 'StrictHostKeyChecking=yes',
      '-o', 'LogLevel=error',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=6',
      '-P', target.port.toString(),
      '-r',
    ];
    if (target.knownHostsFile) {
      args.push('-o', `UserKnownHostsFile=${target.knownHostsFile}`);
    }
    if (target.keyFile) {
      args.push('-i', target.keyFile);
    }
    args.push(localPath, `${target.user}@${target.ip}:${remotePath}`);

    const child = spawn('scp', args);

    child.stdout.on('data', (d: Buffer) => cb.onStdout?.(d.toString()));
    child.stderr.on('data', (d: Buffer) => cb.onStderr?.(d.toString()));

    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new RemoteExitError(`scp upload failed with exit code ${code ?? 'null'}`, code));
    });

    child.on('error', reject);
  });
}
