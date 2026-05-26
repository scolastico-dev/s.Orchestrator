import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isDockerAvailable, startTestSshContainer } from './helpers/docker';
import type { TestSshContainer } from './helpers/docker';
import { testConnection } from '../src/ssh/connection';
import { execRemoteSimple, execRemoteStreaming } from '../src/ssh/executor';
import type { SshTarget } from '../src/ssh/executor';

const SKIP = !isDockerAvailable();

describe.skipIf(SKIP)('SSH connection tests (requires Docker)', () => {
  let container: TestSshContainer;

  beforeAll(async () => {
    container = await startTestSshContainer();
  });

  afterAll(async () => {
    await container.cleanup();
  });

  function target(): SshTarget {
    return {
      ip: container.host,
      port: container.port,
      user: container.user,
      keyFile: container.privateKeyPath,
      knownHostsFile: container.knownHostsPath,
    };
  }

  it('testConnection returns true for a reachable server', async () => {
    const ok = await testConnection(target());
    expect(ok).toBe(true);
  });

  it('testConnection returns false for an unreachable port', async () => {
    const ok = await testConnection({ ip: '127.0.0.1', port: 19999, user: 'root' }, 2);
    expect(ok).toBe(false);
  });

  it('execRemoteSimple runs a command and returns stdout', async () => {
    const out = await execRemoteSimple(target(), 'echo hello-world');
    expect(out.trim()).toBe('hello-world');
  });

  it('execRemoteSimple captures multi-line output', async () => {
    const out = await execRemoteSimple(target(), 'printf "line1\\nline2\\nline3"');
    expect(out).toContain('line1');
    expect(out).toContain('line3');
  });

  it('execRemoteSimple rejects on non-zero exit code', async () => {
    await expect(execRemoteSimple(target(), 'exit 42')).rejects.toThrow('42');
  });

  it('execRemoteSimple calls onStdout callback', async () => {
    const chunks: string[] = [];
    await execRemoteSimple(target(), 'echo callback-test', {
      onStdout: (d) => chunks.push(d),
    });
    expect(chunks.join('').trim()).toBe('callback-test');
  });

  it('execRemoteStreaming streams output and resolves on success', async () => {
    const lines: string[] = [];
    await execRemoteStreaming(target(), 'echo streaming-ok', {
      onStdout: (d) => lines.push(d),
    });
    expect(lines.join('').trim()).toBe('streaming-ok');
  });

  it('execRemoteStreaming rejects when command fails', async () => {
    await expect(execRemoteStreaming(target(), 'exit 1')).rejects.toThrow();
  });

  it('execRemoteSimple can create and read remote files', async () => {
    const dir = '/tmp/s-orch-ssh-test';
    await execRemoteSimple(target(), `mkdir -p ${dir} && echo "testdata" > ${dir}/file.txt`);
    const content = await execRemoteSimple(target(), `cat ${dir}/file.txt`);
    expect(content.trim()).toBe('testdata');
    await execRemoteSimple(target(), `rm -rf ${dir}`);
  });
});

if (SKIP) {
  it('Docker is not available — SSH integration tests skipped', () => {
    console.log('Install Docker and start the daemon to run SSH integration tests.');
  });
}
