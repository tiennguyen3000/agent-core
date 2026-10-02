/**
 * User configuration: `~/.agent-core/config.json` plus `~/.agent-core/.env`.
 *
 * The point is that after setup a user types one command with no environment
 * juggling: the CLI reads the credential from the `.env` file when the shell
 * does not provide it. A shell variable always wins, so `export` still
 * overrides the file for a one-off run.
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type ProviderKind = 'openai-compatible' | 'anthropic';

export interface ProviderPreset {
  readonly id: string;
  readonly label: string;
  readonly kind: ProviderKind;
  readonly apiKeyEnv: string;
  readonly baseUrl: string;
  /** A starting point for the picker; the live list is fetched when possible. */
  readonly models: readonly string[];
  readonly defaultModel: string;
  /** Where `GET <modelsPath>` lists models, relative to `baseUrl`. */
  readonly modelsPath: string;
  readonly docs: string;
}

/**
 * Endpoints this build knows how to speak. `models` is a convenience list for
 * when the provider cannot be reached (offline, missing key); it is not a claim
 * about what any account has access to.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai-compatible',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    defaultModel: 'deepseek-flash',
    modelsPath: '/models',
    docs: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    kind: 'anthropic',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    baseUrl: 'https://api.anthropic.com',
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
    defaultModel: 'claude-sonnet-4-5',
    modelsPath: '/v1/models',
    docs: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'openai',
    label: 'OpenAI (GPT)',
    kind: 'openai-compatible',
    apiKeyEnv: 'OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'o4-mini'],
    defaultModel: 'gpt-5-mini',
    modelsPath: '/models',
    docs: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'google',
    label: 'Google (Gemini)',
    kind: 'openai-compatible',
    apiKeyEnv: 'GOOGLE_API_KEY',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
    defaultModel: 'gemini-2.5-flash',
    modelsPath: '/models',
    docs: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (many models)',
    kind: 'openai-compatible',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['anthropic/claude-sonnet-4.5', 'openai/gpt-5', 'deepseek/deepseek-chat'],
    defaultModel: 'deepseek/deepseek-chat',
    modelsPath: '/models',
    docs: 'https://openrouter.ai/keys',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    kind: 'openai-compatible',
    apiKeyEnv: 'OLLAMA_API_KEY',
    baseUrl: 'http://127.0.0.1:11434/v1',
    models: ['qwen3-coder', 'llama3.2'],
    defaultModel: 'qwen3-coder',
    modelsPath: '/models',
    docs: 'https://ollama.com/download',
  },
];

export interface AgentCoreConfig {
  /** Preset id, or a custom id when `baseUrl` and `kind` are stored too. */
  readonly provider: string;
  readonly model: string;
  /**
   * Extra skill directories to inherit from, e.g. another agent's skill folder
   * (`tiennk skills add ~/.hermes/skills`). Project directories always come
   * first and shadow these.
   */
  readonly skillSources?: readonly string[];
  /** Overrides the preset endpoint (self-hosted, proxy, local server). */
  readonly baseUrl?: string;
  readonly kind?: ProviderKind;
  readonly apiKeyEnv?: string;
}

export interface ConfigPaths {
  readonly dir: string;
  readonly configFile: string;
  readonly envFile: string;
}

export function configPaths(env: Record<string, string | undefined> = process.env): ConfigPaths {
  const dir = env.AGENT_CORE_HOME ?? join(homedir(), '.agent-core');
  return { dir, configFile: join(dir, 'config.json'), envFile: join(dir, '.env') };
}

export function findPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}

/** Preset for `id`, or a synthesised one so a custom endpoint still works. */
export function presetFor(config: AgentCoreConfig): ProviderPreset {
  const preset = findPreset(config.provider);
  if (preset !== undefined) {
    return {
      ...preset,
      ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
      ...(config.apiKeyEnv === undefined ? {} : { apiKeyEnv: config.apiKeyEnv }),
      ...(config.kind === undefined ? {} : { kind: config.kind }),
    };
  }
  return {
    id: config.provider,
    label: config.provider,
    kind: config.kind ?? 'openai-compatible',
    apiKeyEnv: config.apiKeyEnv ?? `${config.provider.toUpperCase()}_API_KEY`,
    baseUrl: config.baseUrl ?? '',
    models: [config.model],
    defaultModel: config.model,
    modelsPath: '/models',
    docs: '',
  };
}

export async function loadConfig(
  env: Record<string, string | undefined> = process.env,
): Promise<AgentCoreConfig | undefined> {
  const { configFile } = configPaths(env);
  try {
    const parsed: unknown = JSON.parse(await readFile(configFile, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    const provider = typeof record.provider === 'string' ? record.provider : undefined;
    const model = typeof record.model === 'string' ? record.model : undefined;
    if (provider === undefined || model === undefined) {
      return undefined;
    }
    const skillSources = Array.isArray(record.skillSources)
      ? record.skillSources.filter((entry): entry is string => typeof entry === 'string')
      : [];
    return {
      provider,
      model,
      ...(skillSources.length > 0 ? { skillSources } : {}),
      ...(typeof record.baseUrl === 'string' ? { baseUrl: record.baseUrl } : {}),
      ...(record.kind === 'anthropic' || record.kind === 'openai-compatible'
        ? { kind: record.kind }
        : {}),
      ...(typeof record.apiKeyEnv === 'string' ? { apiKeyEnv: record.apiKeyEnv } : {}),
    };
  } catch {
    return undefined;
  }
}

export async function saveConfig(
  config: AgentCoreConfig,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const { dir, configFile } = configPaths(env);
  await mkdir(dir, { recursive: true });
  await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

/**
 * Reads `~/.agent-core/.env`. Deliberately tiny: `NAME=value` lines, optional
 * quotes, `#` comments. A real dotenv implementation would add nothing here.
 */
export async function readEnvFile(
  env: Record<string, string | undefined> = process.env,
): Promise<Record<string, string>> {
  const { envFile } = configPaths(env);
  const values: Record<string, string> = {};
  let raw: string;
  try {
    raw = await readFile(envFile, 'utf8');
  } catch {
    return values;
  }
  for (const line of raw.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) {
      continue;
    }
    const name = match[1] ?? '';
    let value = (match[2] ?? '').trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (name.length > 0) {
      values[name] = value;
    }
  }
  return values;
}

/** Writes one credential, preserving the others, with owner-only permissions. */
export async function writeEnvValue(
  name: string,
  value: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const { dir, envFile } = configPaths(env);
  await mkdir(dir, { recursive: true });
  const existing = await readEnvFile(env);
  existing[name] = value;
  const body = Object.entries(existing)
    .map(([key, entry]) => `${key}=${entry}`)
    .join('\n');
  await writeFile(envFile, `${body}\n`, 'utf8');
  await chmod(envFile, 0o600);
  return envFile;
}

/** Shell environment wins, so an `export` still overrides the stored file. */
export async function resolveEnv(
  env: Record<string, string | undefined> = process.env,
): Promise<Record<string, string | undefined>> {
  return { ...(await readEnvFile(env)), ...env };
}

export interface ModelListResult {
  readonly models: readonly string[];
  /** Set when the live list could not be fetched; callers fall back to presets. */
  readonly error?: string;
}

/**
 * Asks the provider what it offers. Both families expose a models endpoint with
 * the same `{ data: [{ id }] }` shape, so one implementation covers them.
 */
export async function fetchModels(
  preset: ProviderPreset,
  apiKey: string | undefined,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response> = (url, init) =>
    fetch(url, init),
): Promise<ModelListResult> {
  if (apiKey === undefined || apiKey.trim() === '') {
    return { models: preset.models, error: `no ${preset.apiKeyEnv} available` };
  }
  const url = `${preset.baseUrl.replace(/\/+$/, '')}${preset.modelsPath}`;
  const headers: Record<string, string> =
    preset.kind === 'anthropic'
      ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      : { authorization: `Bearer ${apiKey}` };
  try {
    const response = await fetchImpl(url, { headers });
    if (!response.ok) {
      return { models: preset.models, error: `HTTP ${response.status}` };
    }
    const parsed = (await response.json()) as { data?: unknown };
    const ids = Array.isArray(parsed.data)
      ? parsed.data
          .map((entry) =>
            typeof entry === 'object' && entry !== null && 'id' in entry
              ? String((entry as { id: unknown }).id)
              : '',
          )
          .filter((id) => id.length > 0)
      : [];
    return ids.length > 0 ? { models: ids } : { models: preset.models, error: 'empty list' };
  } catch (error) {
    return { models: preset.models, error: error instanceof Error ? error.message : 'failed' };
  }
}
