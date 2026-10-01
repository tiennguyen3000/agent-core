// Minimal MCP server over stdio for tests: newline-delimited JSON-RPC 2.0.
// It speaks only what the client needs, plus deliberate failure modes
// (`hang`, `crash`, `junk`) so those paths are exercised against a real process.

let buffer = '';

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.id === undefined) {
    return; // notification: nothing to answer
  }

  switch (request.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'fixture', version: '1.2.3' },
          capabilities: { tools: {} },
        },
      });
      return;

    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          tools: [
            {
              name: 'echo',
              description: 'Echo text back.',
              inputSchema: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text'],
              },
            },
            { name: 'fail', description: 'Always fails.', inputSchema: { type: 'object' } },
            { name: 'hang', description: 'Never answers.', inputSchema: { type: 'object' } },
            { name: 'crash', description: 'Kills the server.', inputSchema: { type: 'object' } },
            { name: 'junk', description: 'Sends a junk line first.', inputSchema: { type: 'object' } },
          ],
        },
      });
      return;

    case 'tools/call': {
      const name = request.params?.name;
      if (name === 'echo') {
        send({
          jsonrpc: '2.0',
          id: request.id,
          result: { content: [{ type: 'text', text: String(request.params?.arguments?.text ?? '') }] },
        });
        return;
      }
      if (name === 'fail') {
        send({
          jsonrpc: '2.0',
          id: request.id,
          result: { content: [{ type: 'text', text: 'boom' }], isError: true },
        });
        return;
      }
      if (name === 'hang') {
        return;
      }
      if (name === 'crash') {
        process.exit(3);
      }
      if (name === 'junk') {
        process.stdout.write('this is not json\n');
        send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'ok' }] } });
        return;
      }
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `unknown tool ${name}` } });
      return;
    }

    default:
      send({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32601, message: `unknown method ${request.method}` },
      });
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf('\n');
    if (line.length > 0) {
      handle(line);
    }
  }
});
process.stdin.on('end', () => {
  process.exit(0);
});
