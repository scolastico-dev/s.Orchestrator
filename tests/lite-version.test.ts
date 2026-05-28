import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { isDockerAvailable, startTestSshContainer, writeTempFile } from './helpers/docker';
import type { TestSshContainer } from './helpers/docker';

const SCRIPT = resolve(__dirname, '../lite-version.sh');
const SKIP_DOCKER = !isDockerAvailable();

// Resolve bash's absolute path once so tests that restrict PATH can still spawn it.
const BASH = spawnSync('which', ['bash'], { encoding: 'utf8' }).stdout.trim() || '/bin/bash';

function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = join(tmpdir(), `s-orch-lite-test-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    cleanup: () => {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

function runScript(
  args: string[],
  { cwd, env = {}, input }: { cwd?: string; env?: Record<string, string>; input?: string } = {}
) {
  return spawnSync(BASH, [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: cwd ?? tmpdir(),
    env: { ...process.env, ...env },
    input,
    timeout: 30_000,
  });
}

// ---------------------------------------------------------------------------
// CLI / config validation — no Docker needed
// ---------------------------------------------------------------------------

describe('lite-version.sh — CLI parsing', () => {
  it('prints usage and exits 0 for --help', () => {
    const r = runScript(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage:');
    expect(r.stdout).toContain('--config');
  });

  it('prints usage and exits 0 for -h', () => {
    const r = runScript(['-h']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage:');
  });

  it('exits 1 and shows error for an unknown option', () => {
    const r = runScript(['--no-such-flag']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Unknown option');
  });

  it('accepts all documented long flags without erroring on flag parsing', () => {
    // Passes all flags with bogus values — will fail later on missing config,
    // but must NOT fail with "Unknown option".
    const r = runScript([
      '--config', '/nonexistent.json',
      '--log-dir', '/tmp',
      '--assets-dir', '/tmp',
      '--scripts-dir', '/tmp',
      '--remote-path', '/tmp/test',
    ]);
    expect(r.stderr).not.toContain('Unknown option');
  });

  it('accepts --exec without erroring on flag parsing', () => {
    const r = runScript(['--exec', 'uptime', '--config', '/nonexistent.json']);
    expect(r.stderr).not.toContain('Unknown option');
    // Fails on missing config, not on the flag itself
    expect(r.stderr).toContain('Config file not found');
  });

  it('accepts --servers without erroring on flag parsing', () => {
    const r = runScript(['--servers', 'web,db', '--config', '/nonexistent.json']);
    expect(r.stderr).not.toContain('Unknown option');
    expect(r.stderr).toContain('Config file not found');
  });
});

describe('lite-version.sh — config validation', () => {
  it('exits 1 when config file does not exist', () => {
    const r = runScript(['-c', '/nonexistent/path/config.json']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Config file not found');
  });

  it('exits 1 for a config file with invalid JSON', () => {
    const { path, cleanup } = writeTempFile('{ not: valid json }');
    try {
      const r = runScript(['-c', path]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('not valid JSON');
    } finally {
      cleanup();
    }
  });

  it('exits 1 when a server entry is missing the ip field', () => {
    const { path, cleanup } = writeTempFile(JSON.stringify({ srv: { port: 22 } }));
    try {
      const r = runScript(['-c', path]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("Missing required 'ip' field");
      expect(r.stderr).toContain('srv');
    } finally {
      cleanup();
    }
  });

  it('exits 1 when a server entry has an empty ip string', () => {
    const { path, cleanup } = writeTempFile(JSON.stringify({ srv: { ip: '' } }));
    try {
      const r = runScript(['-c', path]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("Missing required 'ip' field");
    } finally {
      cleanup();
    }
  });

  it('exits 1 when the config has no server entries', () => {
    const tmp = makeTempDir();
    try {
      const configPath = join(tmp.dir, 'config.json');
      writeFileSync(configPath, '{}');
      const r = runScript(['-c', configPath], { cwd: tmp.dir, env: { HOME: tmp.dir } });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('No servers found');
    } finally {
      tmp.cleanup();
    }
  });
});

describe('lite-version.sh — --servers validation (no Docker needed)', () => {
  it('exits 1 with an error when a --servers name is not in the config', () => {
    const { path, cleanup } = writeTempFile(
      JSON.stringify({ real: { ip: '1.2.3.4', hostKeys: ['ssh-ed25519 AAAA'] } })
    );
    try {
      const r = runScript(['-c', path, '--servers', 'real,ghost']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('Unknown server');
      expect(r.stderr).toContain('ghost');
    } finally {
      cleanup();
    }
  });

  it('exits 1 when all listed --servers names are unknown', () => {
    const { path, cleanup } = writeTempFile(
      JSON.stringify({ real: { ip: '1.2.3.4' } })
    );
    try {
      const r = runScript(['-c', path, '--servers', 'nope,also-nope']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('Unknown server');
    } finally {
      cleanup();
    }
  });
});

describe('lite-version.sh — dependency check', () => {
  it('exits 1 and lists missing tools when required commands are absent', () => {
    const tmp = makeTempDir();
    try {
      // Build a fake bin dir with stubs for all required tools *except* jq so
      // we can verify the dependency check reports exactly the missing tool.
      const fakeBin = join(tmp.dir, 'bin');
      mkdirSync(fakeBin);
      for (const tool of ['ssh', 'scp', 'ssh-keyscan', 'ssh-keygen']) {
        const real = spawnSync('which', [tool], { encoding: 'utf8' }).stdout.trim();
        writeFileSync(
          join(fakeBin, tool),
          `#!/bin/sh\nexec ${real || `/usr/bin/${tool}`} "$@"\n`,
          { mode: 0o755 }
        );
      }
      // jq intentionally absent — dependency check must catch it

      const r = runScript([], { cwd: tmp.dir, env: { PATH: fakeBin } });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('Required tools not found');
      expect(r.stderr).toContain('jq');
      // Confirm the four present tools are NOT reported missing
      for (const tool of ['ssh', 'scp', 'ssh-keyscan', 'ssh-keygen']) {
        const match = new RegExp(`\\b${tool}\\b`);
        expect(r.stderr).not.toMatch(match);
      }
    } finally {
      tmp.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Integration tests — real SSH container via Docker
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_DOCKER)('lite-version.sh — integration tests (requires Docker)', () => {
  let container: TestSshContainer;
  let workDir: string;
  let fakeHome: string;

  beforeAll(async () => {
    container = await startTestSshContainer();
    workDir = join(tmpdir(), `s-orch-lite-integ-${randomBytes(6).toString('hex')}`);
    fakeHome = join(tmpdir(), `s-orch-lite-home-${randomBytes(6).toString('hex')}`);
    mkdirSync(workDir, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
  });

  afterAll(async () => {
    await container.cleanup();
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { rmSync(fakeHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  async function buildConfig(extra: Record<string, unknown> = {}) {
    return {
      'test-server': {
        ip: container.host,
        port: container.port,
        user: container.user,
        keyFile: container.privateKeyPath,
        // knownHostsFile carries all key types so SSH can match its preferred algorithm.
        knownHostsFile: container.knownHostsPath,
        hostKeys: await container.getHostKeys(),
        ...extra,
      },
    };
  }

  it('dry-run completes successfully without running scripts', async () => {
    const testDir = join(workDir, 'dry-run');
    mkdirSync(testDir, { recursive: true });

    const configPath = join(testDir, 'config.json');
    writeFileSync(configPath, JSON.stringify(await buildConfig()));

    const r = runScript(['-c', configPath, '-y', '-n'], {
      cwd: testDir,
      env: { HOME: fakeHome },
    });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[DRY RUN]');
    expect(r.stdout).toContain('ALL DEPLOYMENTS COMPLETED SUCCESSFULLY');
  });

  it('deploys and executes a script on the remote server', async () => {
    const testDir = join(workDir, 'full-deploy');
    const scriptsDir = join(testDir, 'scripts');
    const logDir = join(testDir, 'logs');
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(logDir, { recursive: true });

    writeFileSync(
      join(scriptsDir, '01-hello.sh'),
      '#!/bin/sh\necho "deployment-marker-ok"\n',
      { mode: 0o755 }
    );

    const configPath = join(testDir, 'config.json');
    writeFileSync(configPath, JSON.stringify(await buildConfig()));

    const r = runScript(['-c', configPath, '-y', '--log-dir', logDir, '--scripts-dir', scriptsDir], {
      cwd: testDir,
      env: { HOME: fakeHome },
    });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('deployment-marker-ok');
    expect(r.stdout).toContain('ALL DEPLOYMENTS COMPLETED SUCCESSFULLY');

    const logFile = join(logDir, 'test-server.log');
    expect(existsSync(logFile)).toBe(true);
    const logContent = readFileSync(logFile, 'utf8');
    expect(logContent).toContain('COMPLETED SUCCESSFULLY');
  });

  it('injects SERVER_NAME, SERVER_SSH_PORT, and custom env vars into remote scripts', async () => {
    const testDir = join(workDir, 'env-inject');
    const scriptsDir = join(testDir, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });

    writeFileSync(
      join(scriptsDir, '01-env.sh'),
      '#!/bin/sh\necho "name=$SERVER_NAME port=$SERVER_SSH_PORT custom=$CUSTOM_VAR"\n',
      { mode: 0o755 }
    );

    const configPath = join(testDir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify(await buildConfig({ env: { CUSTOM_VAR: 'hello-world' } }))
    );

    const r = runScript(['-c', configPath, '-y', '--scripts-dir', scriptsDir], {
      cwd: testDir,
      env: { HOME: fakeHome },
    });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('name=test-server');
    expect(r.stdout).toContain(`port=${container.port}`);
    expect(r.stdout).toContain('custom=hello-world');
  });

  it('uploads assets and exposes them via $ASSET_DIR in scripts', async () => {
    const testDir = join(workDir, 'assets-upload');
    const assetsDir = join(testDir, 'assets');
    const scriptsDir = join(testDir, 'scripts');
    mkdirSync(assetsDir, { recursive: true });
    mkdirSync(scriptsDir, { recursive: true });

    writeFileSync(join(assetsDir, 'data.txt'), 'asset-content-xyz');
    writeFileSync(
      join(scriptsDir, '01-check.sh'),
      '#!/bin/sh\ncat "$ASSET_DIR/data.txt"\n',
      { mode: 0o755 }
    );

    const configPath = join(testDir, 'config.json');
    writeFileSync(configPath, JSON.stringify(await buildConfig()));

    const r = runScript(
      ['-c', configPath, '-y', '--assets-dir', assetsDir, '--scripts-dir', scriptsDir],
      { cwd: testDir, env: { HOME: fakeHome } }
    );

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('asset-content-xyz');
  });

  it('runs multiple scripts in sorted order', async () => {
    const testDir = join(workDir, 'multi-script');
    const scriptsDir = join(testDir, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });

    writeFileSync(join(scriptsDir, '02-second.sh'), '#!/bin/sh\necho "step-two"\n', { mode: 0o755 });
    writeFileSync(join(scriptsDir, '01-first.sh'), '#!/bin/sh\necho "step-one"\n', { mode: 0o755 });

    const configPath = join(testDir, 'config.json');
    writeFileSync(configPath, JSON.stringify(await buildConfig()));

    const r = runScript(['-c', configPath, '-y', '--scripts-dir', scriptsDir], {
      cwd: testDir,
      env: { HOME: fakeHome },
    });

    expect(r.status).toBe(0);
    const stepOneIdx = r.stdout.indexOf('step-one');
    const stepTwoIdx = r.stdout.indexOf('step-two');
    expect(stepOneIdx).toBeGreaterThanOrEqual(0);
    expect(stepOneIdx).toBeLessThan(stepTwoIdx);
  });

  it('marks server as failed and exits 1 when a script returns non-zero', async () => {
    const testDir = join(workDir, 'fail-script');
    const scriptsDir = join(testDir, 'scripts');
    const logDir = join(testDir, 'logs');
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(logDir, { recursive: true });

    writeFileSync(join(scriptsDir, '01-fail.sh'), '#!/bin/sh\nexit 42\n', { mode: 0o755 });

    const configPath = join(testDir, 'config.json');
    writeFileSync(configPath, JSON.stringify(await buildConfig()));

    const r = runScript(['-c', configPath, '-y', '--log-dir', logDir, '--scripts-dir', scriptsDir], {
      cwd: testDir,
      env: { HOME: fakeHome },
    });

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('COMPLETED WITH ERRORS');
    expect(r.stdout).toContain('test-server');

    const logContent = readFileSync(join(logDir, 'test-server.log'), 'utf8');
    expect(logContent).toContain('DEPLOYMENT FAILED');
  });

  it('aborts deployment when user declines the confirmation prompt', async () => {
    const testDir = join(workDir, 'abort-confirm');
    mkdirSync(testDir, { recursive: true });

    const configPath = join(testDir, 'config.json');
    writeFileSync(configPath, JSON.stringify(await buildConfig()));

    // Do NOT pass -y; pass 'n' via stdin to decline the prompt
    const r = runScript(['-c', configPath], {
      cwd: testDir,
      env: { HOME: fakeHome },
      input: 'n\n',
    });

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Deployment aborted by user');
  });

  it('proceeds without prompting when -y / --skip-confirm is passed', async () => {
    const testDir = join(workDir, 'skip-confirm');
    const scriptsDir = join(testDir, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });

    writeFileSync(join(scriptsDir, '01-ok.sh'), '#!/bin/sh\necho "no-prompt-ok"\n', { mode: 0o755 });

    const configPath = join(testDir, 'config.json');
    writeFileSync(configPath, JSON.stringify(await buildConfig()));

    const r = runScript(['-c', configPath, '--skip-confirm', '--scripts-dir', scriptsDir], {
      cwd: testDir,
      env: { HOME: fakeHome },
      // No stdin input needed — prompt should be skipped
    });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('no-prompt-ok');
  });

  it('--exec runs a single command instead of scripts', async () => {
    const testDir = join(workDir, 'exec-cmd');
    const scriptsDir = join(testDir, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });

    // This sentinel must NOT appear — exec replaces script execution
    writeFileSync(join(scriptsDir, '01-should-not-run.sh'), '#!/bin/sh\necho "script-ran"\n', { mode: 0o755 });

    const configPath = join(testDir, 'config.json');
    writeFileSync(configPath, JSON.stringify(await buildConfig()));

    const r = runScript(
      ['-c', configPath, '-y', '--scripts-dir', scriptsDir, '--exec', 'echo exec-marker-ok'],
      { cwd: testDir, env: { HOME: fakeHome } }
    );

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('exec-marker-ok');
    expect(r.stdout).not.toContain('script-ran');
    expect(r.stdout).toContain('ALL DEPLOYMENTS COMPLETED SUCCESSFULLY');
  });

  it('--exec receives injected env vars on the remote', async () => {
    const testDir = join(workDir, 'exec-env');
    mkdirSync(testDir, { recursive: true });

    const configPath = join(testDir, 'config.json');
    writeFileSync(configPath, JSON.stringify(await buildConfig({ env: { MY_EXEC_VAR: 'from-exec' } })));

    const r = runScript(
      ['-c', configPath, '-y', '--exec', 'echo "srv=$SERVER_NAME custom=$MY_EXEC_VAR"'],
      { cwd: testDir, env: { HOME: fakeHome } }
    );

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('srv=test-server');
    expect(r.stdout).toContain('custom=from-exec');
  });

  it('importedEnv forwards listed local env vars to the remote via --exec', async () => {
    const testDir = join(workDir, 'imported-env-exec');
    mkdirSync(testDir, { recursive: true });

    const configPath = join(testDir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify(await buildConfig({ importedEnv: ['ORCH_LITE_SECRET'] }))
    );

    const r = runScript(
      ['-c', configPath, '-y', '--exec', 'echo "secret=$ORCH_LITE_SECRET"'],
      { cwd: testDir, env: { HOME: fakeHome, ORCH_LITE_SECRET: 'lite-forwarded-42' } }
    );

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('secret=lite-forwarded-42');
  });

  it('importedEnv forwards listed local env vars to the remote via scripts', async () => {
    const testDir = join(workDir, 'imported-env-script');
    const scriptsDir = join(testDir, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });

    writeFileSync(
      join(scriptsDir, '01-imported.sh'),
      '#!/bin/sh\necho "imported=$ORCH_LITE_SCRIPT_SECRET"\n',
      { mode: 0o755 }
    );

    const configPath = join(testDir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify(await buildConfig({ importedEnv: ['ORCH_LITE_SCRIPT_SECRET'] }))
    );

    const r = runScript(
      ['-c', configPath, '-y', '--scripts-dir', scriptsDir],
      { cwd: testDir, env: { HOME: fakeHome, ORCH_LITE_SCRIPT_SECRET: 'script-forwarded-99' } }
    );

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('imported=script-forwarded-99');
  });

  it('importedEnv does not forward vars that are not set locally', async () => {
    const testDir = join(workDir, 'imported-env-unset');
    mkdirSync(testDir, { recursive: true });

    const configPath = join(testDir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify(await buildConfig({ importedEnv: ['ORCH_LITE_NOT_SET_VAR'] }))
    );

    // Explicitly omit ORCH_LITE_NOT_SET_VAR from the environment
    const r = runScript(
      ['-c', configPath, '-y', '--exec', 'echo "val=${ORCH_LITE_NOT_SET_VAR:-empty}"'],
      { cwd: testDir, env: { HOME: fakeHome } }
    );

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('val=empty');
  });

  it('--exec fails the deployment when the command exits non-zero', async () => {
    const testDir = join(workDir, 'exec-fail');
    mkdirSync(testDir, { recursive: true });

    const configPath = join(testDir, 'config.json');
    writeFileSync(configPath, JSON.stringify(await buildConfig()));

    const r = runScript(
      ['-c', configPath, '-y', '--exec', 'exit 7'],
      { cwd: testDir, env: { HOME: fakeHome } }
    );

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('COMPLETED WITH ERRORS');
  });

  it('--servers targets only listed servers and skips the rest', async () => {
    const testDir = join(workDir, 'servers-filter');
    const scriptsDir = join(testDir, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });

    writeFileSync(join(scriptsDir, '01-mark.sh'), '#!/bin/sh\necho "reached-$SERVER_NAME"\n', { mode: 0o755 });

    // Config has two servers: the real container and a fake unreachable one.
    // Without --servers filtering the fake server would cause a connection failure.
    const configPath = join(testDir, 'config.json');
    const config = {
      ...(await buildConfig()),
      'unreachable-server': {
        ip: '192.0.2.1',  // TEST-NET — guaranteed unreachable
        port: 22,
        user: 'root',
        hostKeys: ['ssh-ed25519 AAAA'],
      },
    };
    writeFileSync(configPath, JSON.stringify(config));

    const r = runScript(
      ['-c', configPath, '-y', '--scripts-dir', scriptsDir, '--servers', 'test-server'],
      { cwd: testDir, env: { HOME: fakeHome } }
    );

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('reached-test-server');
    expect(r.stdout).not.toContain('unreachable-server');
    expect(r.stdout).toContain('ALL DEPLOYMENTS COMPLETED SUCCESSFULLY');
  });

  it('--servers exits 1 when a listed server name is not in the config', async () => {
    const testDir = join(workDir, 'servers-unknown');
    mkdirSync(testDir, { recursive: true });

    const configPath = join(testDir, 'config.json');
    writeFileSync(configPath, JSON.stringify(await buildConfig()));

    const r = runScript(
      ['-c', configPath, '-y', '--servers', 'test-server,does-not-exist'],
      { cwd: testDir, env: { HOME: fakeHome } }
    );

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Unknown server');
    expect(r.stderr).toContain('does-not-exist');
  });
});

if (SKIP_DOCKER) {
  it('Docker is not available — lite-version integration tests skipped', () => {
    console.log('Install Docker and start the daemon to run lite-version integration tests.');
  });
}
