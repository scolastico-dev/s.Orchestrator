import { z } from 'zod';
import { readFileSync, writeFileSync } from 'fs';

const ServerConfigSchema = z
  .object({
    ip: z.string().min(1).describe('Server IP address or hostname'),
    port: z.number().int().min(1).max(65535).optional().default(22).describe('SSH port (default: 22)'),
    user: z.string().min(1).optional().default('root').describe('SSH username (default: root)'),
    hostKeys: z.array(z.string()).optional().describe('Known host public keys (all key types) — auto-populated on first connection'),
    keyFile: z.string().optional().describe('Path to SSH private key file (uses SSH agent/defaults if omitted)'),
    knownHostsFile: z.string().optional().describe('Path to a custom known_hosts file for this server'),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe('Environment variables injected into each script execution'),
  })
  .describe('Configuration for a single remote server');

export const OrchestratorConfigSchema = z
  .record(z.string().min(1), ServerConfigSchema)
  .describe('s.Orchestrator configuration — a map of server name to server config');

export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>;

export function loadConfig(configPath: string): OrchestratorConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read config file "${configPath}": ${(err as NodeJS.ErrnoException).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Config file "${configPath}" is not valid JSON: ${(err as Error).message}`);
  }

  const result = OrchestratorConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Config validation failed:\n${issues}`);
  }
  return result.data;
}

export function saveConfig(configPath: string, config: OrchestratorConfig): void {
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

export function generateJsonSchema(): Record<string, unknown> {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 's-orchestrator-config',
    type: 'object',
    description: 's.Orchestrator configuration — a map of server name to server config',
    additionalProperties: {
      type: 'object',
      description: 'Configuration for a single remote server',
      required: ['ip'],
      properties: {
        ip: { type: 'string', minLength: 1, description: 'Server IP address or hostname' },
        port: { type: 'integer', minimum: 1, maximum: 65535, default: 22, description: 'SSH port (default: 22)' },
        user: { type: 'string', minLength: 1, default: 'root', description: 'SSH username (default: root)' },
        hostKeys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Known host public keys (all key types) — auto-populated on first connection',
        },
        keyFile: { type: 'string', description: 'Path to SSH private key file' },
        knownHostsFile: { type: 'string', description: 'Path to a custom known_hosts file for this server' },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Environment variables injected into each script execution',
        },
      },
      additionalProperties: false,
    },
  };
}

export function exportSchema(outputPath?: string): void {
  const json = JSON.stringify(generateJsonSchema(), null, 2) + '\n';
  if (outputPath) {
    writeFileSync(outputPath, json, 'utf8');
    process.stderr.write(`Schema written to ${outputPath}\n`);
  } else {
    process.stdout.write(json);
  }
}
