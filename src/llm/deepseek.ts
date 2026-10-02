/**
 * DeepSeek provider: the OpenAI-compatible implementation with DeepSeek's
 * endpoint, credential variable and default field spelling.
 *
 * The class stays a subclass so existing callers and tests keep working
 * (`new DeepSeekProvider({...})`, `provider.id === 'deepseek'`, DeepSeek's error
 * wording) while the wire logic lives in one place (M9).
 */

import {
  OpenAiCompatibleProvider,
  createOpenAiCompatibleProvider,
} from './openai-compatible.js';
import type { OpenAiCompatibleOptions } from './openai-compatible.js';

export type DeepSeekProviderOptions = Omit<
  OpenAiCompatibleOptions,
  'id' | 'label' | 'defaultBaseUrl' | 'defaultApiKeyEnv'
>;

export class DeepSeekProvider extends OpenAiCompatibleProvider {
  constructor(options: DeepSeekProviderOptions = {}) {
    super({
      ...options,
      id: 'deepseek',
      label: 'DeepSeek',
      defaultBaseUrl: 'https://api.deepseek.com/v1',
      defaultApiKeyEnv: 'DEEPSEEK_API_KEY',
    });
  }
}

export function createDeepSeekProvider(options: DeepSeekProviderOptions = {}): DeepSeekProvider {
  return new DeepSeekProvider(options);
}

export { createOpenAiCompatibleProvider };
