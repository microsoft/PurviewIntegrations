/**
 * Identity input validation helpers.
 *
 * Author emails come from git commit metadata, which is entirely
 * attacker-controlled (`git commit --author=...`). They are used as cache keys
 * and directory lookup keys, so they are validated before use, and a value that
 * cannot be validated is never treated as a resolved identity.
 */

// Deliberately conservative: single @, no whitespace/quotes/control characters,
// a dotted domain. Anything exotic is rejected rather than looked up.
const EMAIL_PATTERN = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

const MAX_EMAIL_LENGTH = 254;

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Lowercase and validate an email address.
 * Returns undefined when the value is missing or not a plausible address.
 */
export function normalizeEmail(email: string | null | undefined): string | undefined {
  if (!email) return undefined;
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > MAX_EMAIL_LENGTH) return undefined;
  return EMAIL_PATTERN.test(normalized) ? normalized : undefined;
}

/**
 * True when the value is an Entra object ID (GUID). Used to gate
 * authorization-sensitive calls so a malformed or unresolved identity never
 * reaches a protection-scope lookup.
 */
export function isUserId(userId: string | null | undefined): boolean {
  return !!userId && GUID_PATTERN.test(userId.trim());
}

/**
 * Normalize a configured or resolved identity into a value that is safe to use
 * as a Graph `/users/{id | userPrincipalName}` path segment.
 *
 * Returns the GUID for an object ID, the normalized address for a UPN, and
 * undefined for anything else — so a malformed identity can never be spliced
 * into a request URL.
 */
export function normalizeUserIdentity(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (GUID_PATTERN.test(trimmed)) return trimmed.toLowerCase();
  return normalizeEmail(trimmed);
}
