import { useEffect, useRef } from "react";
import { API_BASE } from "./client.ts";

/**
 * Server-sent state (P2.md §5). The stream says what the state is now, at connect and after each change, so a dropped
 * connection loses nothing: `EventSource` reconnects by itself, and the first message puts the caller right.
 */
export function useServerState<T>(path: string | null, onState: (state: T) => void) {
  const latest = useRef(onState);
  latest.current = onState;
  useEffect(() => {
    if (path === null) return;
    const source = new EventSource(`${API_BASE}${path}`);
    source.onmessage = (event) => latest.current(JSON.parse(event.data) as T);
    return () => source.close();
  }, [path]);
}
