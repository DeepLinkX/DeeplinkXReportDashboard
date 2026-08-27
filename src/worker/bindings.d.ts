interface Env {
  /** Set only with `wrangler secret put ADMIN_TOKEN`; never expose this binding publicly. */
  ADMIN_TOKEN: string;
  /** Canonical public dashboard origin. */
  PUBLIC_ORIGIN: string;
}
