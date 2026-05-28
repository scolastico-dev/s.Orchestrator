import { describe, expect, it } from 'vitest';
import { generateJsonSchema, loadConfig, OrchestratorConfigSchema, saveConfig } from '../src/config';
import { writeTempFile } from './helpers/docker';

describe('config validation', () => {
  it('parses a minimal valid config', () => {
    const raw = JSON.stringify({ web: { ip: '1.2.3.4' } });
    const { path, cleanup } = writeTempFile(raw);
    try {
      const cfg = loadConfig(path);
      expect(cfg.web.ip).toBe('1.2.3.4');
      expect(cfg.web.port).toBe(22);
      expect(cfg.web.user).toBe('root');
    } finally {
      cleanup();
    }
  });

  it('applies defaults for port and user', () => {
    const raw = JSON.stringify({ srv: { ip: '10.0.0.1' } });
    const { path, cleanup } = writeTempFile(raw);
    try {
      const cfg = loadConfig(path);
      expect(cfg.srv.port).toBe(22);
      expect(cfg.srv.user).toBe('root');
    } finally {
      cleanup();
    }
  });

  it('accepts a full config', () => {
    const raw = JSON.stringify({
      prod: {
        ip: '192.168.1.1',
        port: 2222,
        user: 'deploy',
        hostKeys: ['ecdsa-sha2-nistp256 AAAA==', 'ssh-ed25519 BBBB=='],
        keyFile: '/home/user/.ssh/deploy',
        env: { APP_ENV: 'production', PORT: '3000' },
      },
    });
    const { path, cleanup } = writeTempFile(raw);
    try {
      const cfg = loadConfig(path);
      expect(cfg.prod.port).toBe(2222);
      expect(cfg.prod.user).toBe('deploy');
      expect(cfg.prod.env?.APP_ENV).toBe('production');
      expect(cfg.prod.hostKeys).toEqual(['ecdsa-sha2-nistp256 AAAA==', 'ssh-ed25519 BBBB==']);
    } finally {
      cleanup();
    }
  });

  it('accepts importedEnv as a string array', () => {
    const raw = JSON.stringify({
      srv: { ip: '10.0.0.1', importedEnv: ['MY_SECRET', 'API_KEY'] },
    });
    const { path, cleanup } = writeTempFile(raw);
    try {
      const cfg = loadConfig(path);
      expect(cfg.srv.importedEnv).toEqual(['MY_SECRET', 'API_KEY']);
    } finally {
      cleanup();
    }
  });

  it('importedEnv defaults to undefined when not specified', () => {
    const raw = JSON.stringify({ srv: { ip: '10.0.0.1' } });
    const { path, cleanup } = writeTempFile(raw);
    try {
      const cfg = loadConfig(path);
      expect(cfg.srv.importedEnv).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('rejects importedEnv containing non-string entries', () => {
    const raw = JSON.stringify({ bad: { ip: '1.2.3.4', importedEnv: [42] } });
    const { path, cleanup } = writeTempFile(raw);
    try {
      expect(() => loadConfig(path)).toThrow('Config validation failed');
    } finally {
      cleanup();
    }
  });

  it('rejects a config with missing ip', () => {
    const raw = JSON.stringify({ bad: { port: 22 } });
    const { path, cleanup } = writeTempFile(raw);
    try {
      expect(() => loadConfig(path)).toThrow('Config validation failed');
    } finally {
      cleanup();
    }
  });

  it('rejects a config with invalid port', () => {
    const raw = JSON.stringify({ bad: { ip: '1.2.3.4', port: 99999 } });
    const { path, cleanup } = writeTempFile(raw);
    try {
      expect(() => loadConfig(path)).toThrow('Config validation failed');
    } finally {
      cleanup();
    }
  });

  it('rejects malformed JSON', () => {
    const { path, cleanup } = writeTempFile('{ invalid json ');
    try {
      expect(() => loadConfig(path)).toThrow('not valid JSON');
    } finally {
      cleanup();
    }
  });

  it('throws a descriptive error when file not found', () => {
    expect(() => loadConfig('/tmp/does-not-exist-s-orch.json')).toThrow('Cannot read config file');
  });

  it('round-trips through save and load', () => {
    const { path, cleanup } = writeTempFile('{}');
    try {
      const cfg = OrchestratorConfigSchema.parse({ alpha: { ip: '10.1.1.1', port: 2200 } });
      saveConfig(path, cfg);
      const loaded = loadConfig(path);
      expect(loaded.alpha.ip).toBe('10.1.1.1');
      expect(loaded.alpha.port).toBe(2200);
    } finally {
      cleanup();
    }
  });
});

describe('JSON schema export', () => {
  it('generates a valid JSON schema object', () => {
    const schema = generateJsonSchema() as Record<string, unknown>;
    expect(schema).toHaveProperty('$schema');
    expect(schema.type).toBe('object');
  });

  it('schema has server property definitions', () => {
    const schema = generateJsonSchema() as Record<string, unknown>;
    const json = JSON.stringify(schema);
    expect(json).toContain('ip');
    expect(json).toContain('port');
    expect(json).toContain('hostKeys');
    expect(json).toContain('importedEnv');
  });
});
