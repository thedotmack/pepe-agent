/**
 * Module-level state for the cold-boot claude-mem session id.
 *
 * Anti-pattern guard (PLAN Phase 0.B): we never persist or share the
 * contentSessionId across restarts. Always mint fresh on cold boot.
 */
import { randomUUID } from "node:crypto";

let contentSessionId: string | null = null;

export function mintContentSessionId(): string {
  contentSessionId = `pepe-agent-${randomUUID()}`;
  return contentSessionId;
}

export function getContentSessionId(): string | null {
  return contentSessionId;
}
