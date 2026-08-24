/**
 * Environment shape.
 *
 * `process.env` satisfies this, and so does a plain object in a test — which means
 * configuration-reading functions can be called with a fabricated environment without a
 * cast. Casts are worth avoiding here specifically: a cast is exactly what would hide a
 * genuine mismatch between what a function expects and what production supplies.
 *
 * Type only. No value, no secret, nothing to bundle.
 */
export type EnvLike = Record<string, string | undefined>;
