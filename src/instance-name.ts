/**
 * Single-point validator for NCL_INSTANCE.
 *
 * The instance name is interpolated into:
 *   - launchd plist XML (<string>${instance}</string>)
 *   - systemd unit `Environment=NCL_INSTANCE=${instance}` (space/newline → split)
 *   - filesystem paths (instances/${instance}/, ~/.onecli-${instance}/,
 *     start-nanoclaw-${instance}.sh, nanoclaw-${instance}.pid)
 *   - log messages
 *
 * Without validation, a hostile or fat-fingered value can do path traversal
 * (`../etc`), XML injection (`</string>...`), unit-file injection (newline +
 * `ExecStart=...`), or — historically with `make deploy-${instance}` —
 * shell command injection.
 *
 * Validating once at every entry point that reads `process.env.NCL_INSTANCE`
 * is cheaper than escaping each sink separately, and means every downstream
 * consumer can trust the value.
 *
 * The charset (`[a-z0-9][a-z0-9_-]{0,31}`) was chosen to match what's safe
 * across launchd, systemd, docker-compose project names, and POSIX file
 * paths. Hyphens and underscores allowed in the body, but the name must
 * start with a letter/digit (no leading `-`/`_`/`.`).
 */

const VALID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function isValidInstanceName(name: string): boolean {
  return VALID.test(name);
}

/**
 * Read NCL_INSTANCE from the environment, trim, and validate.
 * Returns '' (single-install mode) when the env var is unset or empty.
 * Throws with a specific error otherwise — callers should let it propagate
 * so the host fails loudly at startup rather than partially configuring.
 */
export function readInstanceName(): string {
  const raw = (process.env.NCL_INSTANCE || '').trim();
  if (!raw) return '';
  if (!VALID.test(raw)) {
    throw new Error(
      `Invalid NCL_INSTANCE="${raw}". Must match ${VALID} ` +
        `(letters/digits/hyphens/underscores, start with letter/digit, max 32 chars).`,
    );
  }
  return raw;
}
