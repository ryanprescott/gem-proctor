import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Progress over server-sent events (SPEC §11.2, P2.md §5). State lives in the database: an event only says "read it
 * again", and a connection starts with the current state, so a dropped stream loses nothing. In process, because
 * there's one API instance (SPEC §5.3).
 */
export class EventHub {
  private readonly topics = new Map<string, Set<() => void>>();

  subscribe(topic: string, listener: () => void): () => void {
    const listeners = this.topics.get(topic) ?? new Set();
    this.topics.set(topic, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.topics.delete(topic);
    };
  }

  publish(topic: string) {
    for (const listener of this.topics.get(topic) ?? []) listener();
  }
}

const KEEP_ALIVE_MS = 15_000;

/** Streams `state()` on connect and after each event on `topic`, until the client goes away. */
export async function streamState(
  events: EventHub,
  topic: string,
  request: FastifyRequest,
  reply: FastifyReply,
  state: () => Promise<unknown>,
  once = false,
): Promise<string> {
  if (once) {
    reply.header("content-type", "text/event-stream");
    return `data: ${JSON.stringify(await state())}\n\n`;
  }
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  let closed = false;
  let writing = Promise.resolve();
  const send = () => {
    // One at a time, so the states go out in the order they were read.
    writing = writing.then(async () => {
      if (closed) return;
      try {
        res.write(`data: ${JSON.stringify(await state())}\n\n`);
      } catch {
        close();
      }
    });
  };
  const unsubscribe = events.subscribe(topic, send);
  const timer = setInterval(() => {
    if (!closed) res.write(": keep-alive\n\n");
  }, KEEP_ALIVE_MS);
  function close() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    unsubscribe();
    res.end();
  }
  request.raw.once("close", close);
  res.once("close", close);
  send();
  return "";
}
