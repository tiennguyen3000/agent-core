import { describe, expect, it } from 'vitest';
import { assembleResponse } from '../src/index.js';
import type { LLMDelta } from '../src/index.js';

describe('assembleResponse', () => {
  it('folds text, reasoning, usage and stop into one response', () => {
    const deltas: LLMDelta[] = [
      { type: 'reasoning', text: 'think' },
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 2 } },
      { type: 'stop', reason: 'end' },
    ];

    const response = assembleResponse(deltas);

    expect(response).toEqual({
      text: 'Hello',
      reasoning: 'think',
      toolCalls: [],
      usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 2 },
      stop: 'end',
      errorCode: undefined,
      malformedToolArgs: [],
    });
  });

  it('reassembles tool calls from fragments sharing an index', () => {
    const deltas: LLMDelta[] = [
      { type: 'tool_call', index: 0, id: 'c1', name: 'fs.read', argsJsonDelta: '{"pa' },
      { type: 'tool_call', index: 1, id: 'c2', name: 'glob', argsJsonDelta: '{"pattern":' },
      { type: 'tool_call', index: 0, argsJsonDelta: 'th":"a.txt"}' },
      { type: 'tool_call', index: 1, argsJsonDelta: '"*.ts"}' },
      { type: 'stop', reason: 'tool_calls' },
    ];

    const response = assembleResponse(deltas);

    expect(response.toolCalls).toEqual([
      { id: 'c1', name: 'fs.read', args: { path: 'a.txt' } },
      { id: 'c2', name: 'glob', args: { pattern: '*.ts' } },
    ]);
    expect(response.stop).toBe('tool_calls');
  });

  it('reports malformed argument JSON instead of throwing', () => {
    const response = assembleResponse([
      { type: 'tool_call', index: 0, id: 'c1', name: 'fs.read', argsJsonDelta: '{oops' },
      { type: 'stop', reason: 'tool_calls' },
    ]);

    expect(response.toolCalls).toEqual([{ id: 'c1', name: 'fs.read', args: {} }]);
    expect(response.malformedToolArgs).toEqual([{ index: 0, raw: '{oops' }]);
  });

  it('treats missing or empty arguments as an empty object', () => {
    const response = assembleResponse([
      { type: 'tool_call', index: 0, id: 'c1', name: 'todo' },
      { type: 'tool_call', index: 1, id: 'c2', name: 'todo', argsJsonDelta: '   ' },
      { type: 'stop', reason: 'tool_calls' },
    ]);

    expect(response.toolCalls).toEqual([
      { id: 'c1', name: 'todo', args: {} },
      { id: 'c2', name: 'todo', args: {} },
    ]);
    expect(response.malformedToolArgs).toEqual([]);
  });

  it('synthesizes an id and keeps an error code from the stop delta', () => {
    const response = assembleResponse([
      { type: 'tool_call', index: 0, name: 'fs.read', argsJsonDelta: '{}' },
      { type: 'stop', reason: 'error', errorCode: 'E_RATE_LIMITED' },
    ]);

    expect(response.toolCalls).toEqual([{ id: 'call_0', name: 'fs.read', args: {} }]);
    expect(response.stop).toBe('error');
    expect(response.errorCode).toBe('E_RATE_LIMITED');
    expect(response.usage).toBeUndefined();
  });

  it('defaults to a finished stop when the provider never sent one', () => {
    expect(assembleResponse([{ type: 'text', text: 'hi' }]).stop).toBe('end');
  });
});
