import { spawn } from 'child_process';
import type { SshTarget } from './executor';

export function testConnection(target: SshTarget, timeoutSeconds = 10): Promise<boolean> {
  return new Promise((resolve) => {
    const args: string[] = [
      '-o', 'BatchMode=yes',
      '-o', `ConnectTimeout=${timeoutSeconds}`,
      '-o', 'StrictHostKeyChecking=yes',
      '-o', 'LogLevel=error',
      '-p', target.port.toString(),
    ];
    if (target.knownHostsFile) {
      args.push('-o', `UserKnownHostsFile=${target.knownHostsFile}`);
    }
    if (target.keyFile) {
      args.push('-i', target.keyFile);
    }
    args.push(`${target.user}@${target.ip}`, 'exit');

    const child = spawn('ssh', args);
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}
