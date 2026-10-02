/**
 * Turns a stored configuration into a provider instance.
 *
 * One place decides which implementation speaks a provider, so the CLI never
 * branches on provider names.
 */

import { createAnthropicProvider } from './anthropic.js';
import { createOpenAiCompatibleProvider } from './openai-compatible.js';
import type { LLMProvider } from './types.js';
import { presetFor } from '../config/store.js';
import type { AgentCoreConfig } from '../config/store.js';

export interface ProviderOverrides {
  readonly baseUrl?: string;
  readonly model?: string;
}

export function createProviderFor(
  config: AgentCoreConfig,
  env: Record<string, string | undefined>,
): LLMProvider {
  const preset = presetFor(config);
  if (preset.kind === 'anthropic') {
    return createAnthropicProvider({
      baseUrl: preset.baseUrl,
      apiKeyEnv: preset.apiKeyEnv,
      env,
    });
  }
  return createOpenAiCompatibleProvider({
    id: preset.id,
    label: preset.label,
    baseUrl: preset.baseUrl,
    apiKeyEnv: preset.apiKeyEnv,
    env,
  });
}

/** The environment variable that must hold this provider's credential. */
export function apiKeyEnvFor(config: AgentCoreConfig): string {
  return presetFor(config).apiKeyEnv;
}
