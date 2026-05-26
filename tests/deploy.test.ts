import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { isDockerAvailable, startTestSshContainer } from './helpers/docker';
import type { TestSshContainer } from './helpers/docker';
import { deployServer } from '../src/deploy/steps';
import { testConnection } from '../src/ssh/connection';
import { FileLogger } from '../src/logger';
import type { ServerLogger } from '../src/ui/types';

const SKIP = !isDockerAvailable();

function makeSilentLogger(): ServerLogger {
  return {
    log: vi.fn(),
    write: vi.fn(),
    setActiveChild: vi.fn(),
  };
}

describe.skipIf(SKIP)('deploy integration tests (requires Docker)', () => {
  let container: TestSshContainer;
  let workDir: string;

  beforeAll(async () => {
    container = await startTestSshContainer();
    workDir = join(tmpdir(), `s-orch-deploy-test-${randomBytes(6).toString('hex')}`);
    mkdirSync(workDir, { recursive: true });
  });

  afterAll(async () => {
    await container.cleanup();
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('can connect to the test container', async () => {
    const ok = await testConnection({
      ip: container.host,
      port: container.port,
      user: container.user,
      keyFile: container.privateKeyPath,
      knownHostsFile: container.knownHostsPath,
    });
    expect(ok).toBe(true);
  });

  it('deployServer runs scripts and cleans up', async () => {
    const scriptsDir = join(workDir, 'scripts');
    const logDir = join(workDir, 'logs');
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(logDir, { recursive: true });

    writeFileSync(join(scriptsDir, '01-hello.sh'), '#!/bin/sh\necho "hello from script"\n', { mode: 0o755 });
    writeFileSync(join(scriptsDir, '02-env.sh'), '#!/bin/sh\necho "env=$TEST_VAR"\n', { mode: 0o755 });

    const logger = makeSilentLogger();
    const fileLogger = new FileLogger(logDir);
    fileLogger.register('test-server');

    const scriptsDone: number[] = [];

    await deployServer({
      serverName: 'test-server',
      config: {
        ip: container.host,
        port: container.port,
        user: container.user,
        keyFile: container.privateKeyPath,
        knownHostsFile: container.knownHostsPath,
        hostKeys: await container.getHostKeys(),
        env: { TEST_VAR: 'hello-env' },
      },
      scripts: ['01-hello.sh', '02-env.sh'],
      assetsDir: join(workDir, 'assets-nonexistent'),
      scriptsDir,
      remotePath: '/tmp/s-orch-deploy-integ',
      logger,
      fileLogger,
      onScriptDone: (n) => scriptsDone.push(n),
    });

    expect(scriptsDone).toEqual([1, 2]);

    // Verify logger received output
    const logMock = logger.log as ReturnType<typeof vi.fn>;
    const allMessages: string = logMock.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(allMessages).toContain('COMPLETED SUCCESSFULLY');
  });

  it('deployServer rejects when a script fails', async () => {
    const scriptsDir = join(workDir, 'fail-scripts');
    const logDir = join(workDir, 'fail-logs');
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(logDir, { recursive: true });

    writeFileSync(join(scriptsDir, '01-fail.sh'), '#!/bin/sh\nexit 42\n', { mode: 0o755 });

    const logger = makeSilentLogger();
    const fileLogger = new FileLogger(logDir);
    fileLogger.register('fail-server');

    await expect(
      deployServer({
        serverName: 'fail-server',
        config: {
          ip: container.host,
          port: container.port,
          user: container.user,
          keyFile: container.privateKeyPath,
          knownHostsFile: container.knownHostsPath,
          hostKeys: await container.getHostKeys(),
        },
        scripts: ['01-fail.sh'],
        assetsDir: join(workDir, 'assets-none'),
        scriptsDir,
        remotePath: '/tmp/s-orch-deploy-fail',
        logger,
        fileLogger,
        onScriptDone: vi.fn(),
      })
    ).rejects.toThrow();
  });
});

if (SKIP) {
  it('Docker is not available — deploy integration tests skipped', () => {
    console.log('Install Docker and start the daemon to run deploy integration tests.');
  });
}
