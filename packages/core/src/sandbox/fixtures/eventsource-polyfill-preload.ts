/**
 * Minimal `EventSource` stand-in loaded via `node --import` so allowlist-mode runner tests can
 * assert neutralization when the runtime does not ship a native `EventSource` global.
 */
(globalThis as { EventSource?: new (url: string) => unknown }).EventSource = class EventSource {
  constructor(_url: string) {}
};
