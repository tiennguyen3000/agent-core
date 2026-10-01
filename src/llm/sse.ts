/**
 * A dependency-free Server-Sent Events parser.
 *
 * It follows the subset of the SSE spec that streaming chat APIs use: `data`,
 * `event` and `id` fields, `:` comments, and blank-line dispatch. It is written
 * against a byte/string stream so a chunk boundary may fall anywhere — in the
 * middle of a line, in the middle of a `\r\n`, or right after a `\r`.
 */

export interface SseEvent {
  readonly data: string;
  readonly event: string | undefined;
  readonly id: string | undefined;
}

const LINE_BREAK = /\r\n|\n|\r/;

export async function* parseSseStream(
  source: AsyncIterable<Uint8Array | string>,
): AsyncIterable<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName: string | undefined;
  let eventId: string | undefined;
  let dataLines: string[] = [];

  const dispatch = (): SseEvent | undefined => {
    const name = eventName;
    const id = eventId;
    eventName = undefined;
    eventId = undefined;
    if (dataLines.length === 0) {
      // A block of comments/fields with no `data` is not an event.
      return undefined;
    }
    const data = dataLines.join('\n');
    dataLines = [];
    return { data, event: name, id };
  };

  const consumeLine = (line: string): SseEvent | undefined => {
    if (line === '') {
      return dispatch();
    }
    if (line.startsWith(':')) {
      return undefined;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    switch (field) {
      case 'data':
        dataLines.push(value);
        break;
      case 'event':
        eventName = value;
        break;
      case 'id':
        eventId = value;
        break;
      default:
        // `retry` and unknown fields are ignored.
        break;
    }
    return undefined;
  };

  for await (const chunk of source) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });

    let match = LINE_BREAK.exec(buffer);
    while (match !== null) {
      const isTrailingLoneCr =
        match[0] === '\r' && match.index + match[0].length === buffer.length;
      if (isTrailingLoneCr) {
        // Could be the first half of a CRLF split across chunks: wait.
        break;
      }
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const event = consumeLine(line);
      if (event !== undefined) {
        yield event;
      }
      match = LINE_BREAK.exec(buffer);
    }
  }

  buffer += decoder.decode();
  if (buffer.length > 0) {
    const event = consumeLine(buffer);
    if (event !== undefined) {
      yield event;
    }
  }
  const trailing = dispatch();
  if (trailing !== undefined) {
    yield trailing;
  }
}
