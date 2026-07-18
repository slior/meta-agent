/**
 * How the tool should pass the URL into `fetch` (exercises host extraction shapes in the runner shim).
 */
export const NET_FETCH_INPUT_AS = {
  STRING: "string",
  URL: "url",
  REQUEST: "request",
} as const;

/** Discriminator for {@link NetFetchInput.as}. */
export type NetFetchInputAs = (typeof NET_FETCH_INPUT_AS)[keyof typeof NET_FETCH_INPUT_AS];

/**
 * Caller-requested `fetch` redirect mode. The runner shim must override this to `"manual"` in allowlist mode.
 */
export const NET_FETCH_REDIRECT = {
  FOLLOW: "follow",
  MANUAL: "manual",
  ERROR: "error",
} as const;

/** Discriminator for {@link NetFetchInput.redirect}. */
export type NetFetchRedirect = (typeof NET_FETCH_REDIRECT)[keyof typeof NET_FETCH_REDIRECT];

/** Input for the net-fetch sandbox fixture tool. */
export type NetFetchInput = {
  url: string;
  as?: NetFetchInputAs;
  /** Passed into `fetch` init; the allowlist shim must force `"manual"` regardless. */
  redirect?: NetFetchRedirect;
};

/**
 * Fetches `url` using the global `fetch`, optionally wrapping the target as a `URL` or `Request`.
 *
 * @param input - Target URL, optional input-shape mode, and optional caller redirect preference.
 * @returns HTTP status and `Location` header (if any).
 */
export async function run(input: NetFetchInput): Promise<{ status: number; location: string | null }> {
  const target = input.url;
  const arg =
    input.as === NET_FETCH_INPUT_AS.URL ? new URL(target) :
    input.as === NET_FETCH_INPUT_AS.REQUEST ? new Request(target) :
    target;
  const init = input.redirect === undefined ? undefined : { redirect: input.redirect };
  const res = await fetch(arg as Parameters<typeof fetch>[0], init);
  return { status: res.status, location: res.headers.get("location") };
}
