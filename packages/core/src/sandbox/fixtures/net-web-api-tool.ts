/**
 * Which unguarded network global the fixture should invoke (blocked in allowlist mode).
 */
export const NET_WEB_API = {
  WEBSOCKET: "websocket",
  EVENTSOURCE: "eventsource",
} as const;

/** Discriminator for {@link NetWebApiInput.api}. */
export type NetWebApiKind = (typeof NET_WEB_API)[keyof typeof NET_WEB_API];

/** Input for the net-web-api sandbox fixture tool. */
export type NetWebApiInput = {
  api: NetWebApiKind;
  url: string;
};

/**
 * Constructs `WebSocket` or `EventSource` against `url` (expected to be denied by the runner net shim).
 *
 * @param input - Which API to call and the target URL.
 */
export function run(input: NetWebApiInput): void {
  if (input.api === NET_WEB_API.WEBSOCKET) {
    new WebSocket(input.url);
  } else {
    new EventSource(input.url);
  }
}
