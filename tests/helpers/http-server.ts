import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/** What the test server saw, so assertions can inspect the outgoing request. */
export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly rawBody: string;
  readonly body: unknown;
}

export type TestHandler = (
  request: RecordedRequest,
  response: ServerResponse,
  index: number,
) => void | Promise<void>;

export interface TestServer {
  readonly url: string;
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Starts an SSE response. Callers then write `sseChunk(...)` and end. */
export function sseHeaders(response: ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
}

export function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export const SSE_DONE = 'data: [DONE]\n\n';

/**
 * A loopback HTTP server for provider tests. It never leaves the machine, so
 * the suite stays offline (invariant 10).
 */
export async function startTestServer(handler: TestHandler): Promise<TestServer> {
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();

  const server = createServer((incoming, response) => {
    const record = async (): Promise<void> => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) {
        chunks.push(chunk as Buffer);
      }
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const index = requests.length;
      requests.push({
        method: incoming.method ?? 'GET',
        path: incoming.url ?? '/',
        headers: incoming.headers,
        rawBody,
        body: rawBody.length > 0 ? tryParseJson(rawBody) : undefined,
      });
      await handler(requests[index] as RecordedRequest, response, index);
    };
    void record();
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
