import { afterEach, describe, expect, it } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import {
  PROVIDER_PRESETS,
  configPaths,
  fetchModels,
  findPreset,
  loadConfig,
  presetFor,
  readEnvFile,
  resolveEnv,
  saveConfig,
  writeEnvValue,
} from '../src/index.js';
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => removeTmpDir(dir)));
});

async function home(): Promise<Record<string, string>> {
  const dir = await makeTmpDir();
  dirs.push(dir);
  return { AGENT_CORE_HOME: dir };
}

describe('config paths and presets', () => {
  it('honours AGENT_CORE_HOME and otherwise uses the home directory', () => {
    expect(configPaths({ AGENT_CORE_HOME: '/tmp/x' }).configFile).toBe('/tmp/x/config.json');
    expect(configPaths({}).configFile.endsWith('/.agent-core/config.json')).toBe(true);
    expect(configPaths({}).envFile.endsWith('/.agent-core/.env')).toBe(true);
  });

  it('knows the providers this build can speak', () => {
    expect(PROVIDER_PRESETS.map((preset) => preset.id)).toEqual([
      'deepseek',
      'anthropic',
      'openai',
      'google',
      'openrouter',
      'ollama',
    ]);
    expect(findPreset('anthropic')?.kind).toBe('anthropic');
    expect(findPreset('nope')).toBeUndefined();
  });

  it('lets a stored baseUrl and kind override the preset, even for a custom provider', () => {
    const overridden = presetFor({
      provider: 'deepseek',
      model: 'x',
      baseUrl: 'http://localhost:8000/v1',
    });
    expect(overridden.baseUrl).toBe('http://localhost:8000/v1');
    expect(overridden.apiKeyEnv).toBe('DEEPSEEK_API_KEY');

    const custom = presetFor({
      provider: 'my-gateway',
      model: 'my-model',
      baseUrl: 'http://gateway/v1',
      kind: 'openai-compatible',
      apiKeyEnv: 'GATEWAY_KEY',
    });
    expect(custom.kind).toBe('openai-compatible');
    expect(custom.apiKeyEnv).toBe('GATEWAY_KEY');
    expect(custom.defaultModel).toBe('my-model');
  });
});

describe('config file', () => {
  it('round-trips provider and model', async () => {
    const env = await home();
    expect(await loadConfig(env)).toBeUndefined();

    await saveConfig({ provider: 'anthropic', model: 'claude-sonnet-4-5' }, env);

    expect(await loadConfig(env)).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    const raw = JSON.parse(await readFile(configPaths(env).configFile, 'utf8')) as unknown;
    expect(raw).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-5' });
  });

  it('ignores a malformed or incomplete file instead of throwing', async () => {
    const env = await home();
    await saveConfig({ provider: 'deepseek', model: 'deepseek-flash' }, env);
    const { configFile } = configPaths(env);
    await writeFileForTest(configFile, '{ not json');
    expect(await loadConfig(env)).toBeUndefined();

    await writeFileForTest(configFile, JSON.stringify({ model: 'only-model' }));
    expect(await loadConfig(env)).toBeUndefined();
  });
});

async function writeFileForTest(path: string, contents: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, contents, 'utf8');
}

describe('credential file', () => {
  it('parses quotes, comments and export prefixes', async () => {
    const env = await home();
    const { envFile } = configPaths(env);
    await writeFileForTest(
      envFile,
      ['# a comment', 'DEEPSEEK_API_KEY="sk-one"', "export OTHER_KEY='two'", 'EMPTY='].join('\n'),
    );

    expect(await readEnvFile(env)).toEqual({
      DEEPSEEK_API_KEY: 'sk-one',
      OTHER_KEY: 'two',
      EMPTY: '',
    });
  });

  it('stores a value with owner-only permissions and keeps the others', async () => {
    const env = await home();
    await writeEnvValue('DEEPSEEK_API_KEY', 'sk-one', env);
    await writeEnvValue('ANTHROPIC_API_KEY', 'sk-two', env);

    expect(await readEnvFile(env)).toEqual({
      DEEPSEEK_API_KEY: 'sk-one',
      ANTHROPIC_API_KEY: 'sk-two',
    });
    const info = await stat(configPaths(env).envFile);
    expect(info.mode & 0o077).toBe(0);
  });

  it('lets an exported variable win over the stored file', async () => {
    const env = await home();
    await writeEnvValue('DEEPSEEK_API_KEY', 'from-file', env);

    const resolved = await resolveEnv({ ...env, DEEPSEEK_API_KEY: 'from-shell' });

    expect(resolved.DEEPSEEK_API_KEY).toBe('from-shell');
  });
});

describe('model listing', () => {
  const preset = findPreset('deepseek');
  if (preset === undefined) {
    throw new Error('deepseek preset missing');
  }

  it('reads the provider list and falls back when it fails', async () => {
    const ok = await fetchModels(preset, 'sk-test', async () =>
      new Response(JSON.stringify({ data: [{ id: 'm-one' }, { id: 'm-two' }] }), { status: 200 }),
    );
    expect(ok).toEqual({ models: ['m-one', 'm-two'] });

    const unauthorized = await fetchModels(preset, 'sk-test', async () =>
      new Response('nope', { status: 401 }),
    );
    expect(unauthorized.models).toEqual(preset.models);
    expect(unauthorized.error).toBe('HTTP 401');

    const thrown = await fetchModels(preset, 'sk-test', async () => {
      throw new Error('offline');
    });
    expect(thrown.error).toBe('offline');

    const empty = await fetchModels(preset, 'sk-test', async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    expect(empty.error).toBe('empty list');
  });

  it('does not call the network without a key', async () => {
    let called = false;
    const result = await fetchModels(preset, undefined, async () => {
      called = true;
      return new Response('{}');
    });

    expect(called).toBe(false);
    expect(result.error).toContain('DEEPSEEK_API_KEY');
    expect(result.models).toEqual(preset.models);
  });

  it('uses the Anthropic headers for the Anthropic endpoint', async () => {
    const anthropic = findPreset('anthropic');
    if (anthropic === undefined) {
      throw new Error('anthropic preset missing');
    }
    let seen: RequestInit | undefined;
    await fetchModels(anthropic, 'sk-ant', async (url, init) => {
      seen = init;
      expect(url).toBe('https://api.anthropic.com/v1/models');
      return new Response(JSON.stringify({ data: [{ id: 'claude-x' }] }), { status: 200 });
    });

    expect(seen?.headers).toMatchObject({
      'x-api-key': 'sk-ant',
      'anthropic-version': '2023-06-01',
    });
  });
});
