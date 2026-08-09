/**
 * YAML secret masking — M2a
 *
 * Parses a Mihomo config.yaml with js-yaml, walks the resulting value tree
 * at any depth (objects and arrays alike), and replaces every value keyed by
 * a case-insensitive match against SENSITIVE_KEYS with a fixed sentinel
 * string, then re-serializes with js-yaml's dumper.
 *
 * MASK_SENTINEL is a cross-milestone contract: M2b's apply path resubstitutes
 * this exact literal with the original value (matched by baseHash), so it
 * must never change once agents/collectors in the field depend on it.
 *
 * Parse failures never leak the original (possibly-sensitive) text: on any
 * YAMLException — from the parse itself, or from an unexpected failure in
 * the masking/dump step below — maskedContent comes back empty with
 * parseError: true. Safer to show nothing than to risk masking failing
 * silently on malformed input.
 *
 * Two-pass masking (key-based, then value-based):
 * js-yaml gives mapping/sequence aliases a *shared object reference* at
 * every alias site (mutating one mutates all of them for free), but scalar
 * aliases — which is what every real secret actually is — are independent
 * primitive copies at each site. A `password: &pw s3cret` / `notes: *pw`
 * document has two sites holding the identical string, neither aware of the
 * other; masking by key alone only reaches the `password` site and leaves
 * the alias site (`notes`, not a sensitive key) holding the plaintext
 * verbatim. So after the key-based pass, every ORIGINAL secret STRING value
 * (before its own sentinel substitution) that is >= MIN_SECRET_VALUE_LENGTH
 * characters is collected, and a second pass masks any OTHER site anywhere
 * in the tree whose value is exactly equal to one of those strings — this
 * is intentionally fail-closed: a coincidentally-equal non-secret string
 * gets over-masked rather than risk under-masking a real alias.
 *
 * Documented residuals:
 * - Only STRING secrets are value-propagated. A numeric scalar alias of a
 *   numeric secret (e.g. a `port`-like field that happens to equal a
 *   numeric `token:`) is NOT propagated — masking every occurrence of an
 *   equal *number* anywhere in the document would corrupt unrelated ports/
 *   counts/timeouts, and a numeric secret living under a non-sensitive key
 *   is judged out of this threat model.
 * - The MIN_SECRET_VALUE_LENGTH floor exists to avoid over-masking trivial
 *   values (short placeholder strings, enum-like tags) that happen to
 *   collide.
 * - `<<:` YAML merge keys are NOT flattened by js-yaml 5.2.3's default
 *   schema (unlike js-yaml 4.x's DEFAULT_SCHEMA) — `<<` survives as a
 *   literal key holding the referenced mapping as a nested value, which the
 *   generic recursive walk below still descends into and masks correctly.
 *   This safety is incidental to the current default schema, not a design
 *   guarantee of this module — re-run the alias/merge-key tests in
 *   yaml-mask.test.ts on any js-yaml version bump.
 */
import { dump, load, YAMLException } from 'js-yaml';

// js-yaml 5.x's load() throws (rather than returning undefined, as 4.x did)
// when a document contains no content at all — an empty string, or a
// whitespace/comment-only body that resolves to zero YAML documents — and
// this exact reason string is the only call site that throws it (see
// js-yaml's loader: `if (documents.length === 0) throw new
// YAMLException("expected a document, but the input is empty")`). That is a
// VALID empty document (nothing to mask), not malformed input, so it must
// not surface as parseError: true.
const EMPTY_DOCUMENT_REASON = 'expected a document, but the input is empty';

export const MASK_SENTINEL = '__ORBIT_MASKED__';

export interface MaskResult {
  maskedContent: string;
  maskedPaths: string[];
  parseError: boolean;
}

// Case-insensitive on the exact literals below — no separator normalization
// (e.g. `-` vs `_` are distinct literals, hence both `auth-str` and
// `auth_str` are listed explicitly). Any nesting depth, including array
// elements.
//
// Exact-match only — never substring-match a fragment like "key", which
// would also catch WireGuard's `public-key` (not a secret; must survive
// masking so M2b's editor can display it).
const SENSITIVE_KEYS = new Set([
  'password',
  'passwords',
  'secret',
  'token',
  'uuid',
  'private-key',
  'preshared-key',
  'auth-str',
  'auth_str',
  'psk',
  'obfs-password',
  'private-key-passphrase',
  'authentication',
  'obfs-param',
  'protocol-param',
]);

// Top-level keys under which every entry is a provider config map keyed by
// an arbitrary, user-chosen provider name. The provider's `url` (a
// subscription link that routinely embeds an auth token as a query param)
// lives at PROVIDERS_KEY.<name>.url — see maskProviderMapUrls, which handles
// this STRUCTURALLY (real object traversal, keyed off the actual top-level
// object) rather than by reconstructing/matching the `.`-joined path
// string. A path-string regex was tried first and rejected: maskedPaths
// entries join keys with `.` purely for human-readable reporting, and a
// provider name containing a literal `.` (e.g. `sub.example`) or `[`/`]`
// makes the joined string structurally ambiguous — indistinguishable from
// an extra nesting level — so re-parsing it to decide "is this a provider
// entry" silently under-masks any provider name that isn't a single clean
// path segment. Structural traversal has no such blind spot: provider names
// may contain any character at all.
const PROVIDERS_KEYS = ['proxy-providers', 'rule-providers'] as const;

/**
 * Masks the `url` field of every entry in a top-level providers map
 * (`proxy-providers` / `rule-providers`), structurally: iterates the map's
 * actual own keys (provider names) rather than matching against a
 * reconstructed path string, so provider names containing dots, brackets,
 * or anything else are handled correctly. Only `providersMap` itself needs
 * to be the top-level value — the caller is responsible for only invoking
 * this on the actual top-level `proxy-providers`/`rule-providers` value,
 * which is what keeps this scoped and out of reach of an unrelated
 * same-named nested map elsewhere in the document.
 *
 * Runs after the generic key-based pass (maskByKey) so it can still add the
 * original url to secretValues for pass 2's alias propagation, same as any
 * other masked secret.
 */
function maskProviderMapUrls(
  providersMap: unknown,
  parentKey: string,
  maskedPaths: string[],
  secretValues: Set<string>,
): void {
  if (providersMap === null || typeof providersMap !== 'object' || Array.isArray(providersMap)) {
    return;
  }
  for (const providerName of Object.keys(providersMap as Record<string, unknown>)) {
    const entry = (providersMap as Record<string, unknown>)[providerName];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const entryRecord = entry as Record<string, unknown>;
    const urlValue = entryRecord.url;
    if (typeof urlValue !== 'string' || urlValue === MASK_SENTINEL) {
      continue;
    }
    if (urlValue.length >= MIN_SECRET_VALUE_LENGTH) {
      secretValues.add(urlValue);
    }
    entryRecord.url = MASK_SENTINEL;
    maskedPaths.push(`${parentKey}.${providerName}.url`);
  }
}

// Floor for cross-site value-equality propagation (pass 2 below) — a
// collected secret shorter than this is judged too likely to collide with
// unrelated legitimate values, so it is masked only at its own key site.
const MIN_SECRET_VALUE_LENGTH = 6;

/**
 * Pass 1: masks sensitive-keyed values in a parsed YAML value tree and
 * collects the ORIGINAL string values that got masked (before sentinel
 * substitution) into `secretValues`, for pass 2 to propagate by value.
 * Mutates and returns arrays/objects in place (rather than cloning) so that
 * mapping/sequence alias references js-yaml resolved to the same object
 * instance stay masked at every alias site, not just the first one visited.
 *
 * `value !== MASK_SENTINEL` guards against a shared-object alias site being
 * revisited after an earlier visit already mutated it: without the guard,
 * the second visit would read back MASK_SENTINEL itself (>= the length
 * floor) and pollute secretValues with the sentinel string, causing pass 2
 * to spuriously "re-mask" every already-masked site in the document.
 */
function maskByKey(node: unknown, path: string, maskedPaths: string[], secretValues: Set<string>): unknown {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const item = node[i];
      // A string array element that already matches a secret collected
      // earlier in this same top-down pass (e.g. a scalar alias appearing
      // after its anchor) is masked directly rather than recursed into —
      // recursing would no-op on a string and leave it untouched. This
      // mirrors the identical check in maskByValue's array branch, which is
      // what actually closes this gap in the common case (pass 2 runs after
      // ALL secrets are collected, not just the ones visited so far).
      if (typeof item === 'string' && item !== MASK_SENTINEL && secretValues.has(item)) {
        node[i] = MASK_SENTINEL;
        maskedPaths.push(`${path}[${i}]`);
      } else {
        node[i] = maskByKey(item, `${path}[${i}]`, maskedPaths, secretValues);
      }
    }
    return node;
  }

  if (node !== null && typeof node === 'object') {
    for (const key of Object.keys(node as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      const value = (node as Record<string, unknown>)[key];
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        if (typeof value === 'string' && value.length >= MIN_SECRET_VALUE_LENGTH && value !== MASK_SENTINEL) {
          secretValues.add(value);
        }
        (node as Record<string, unknown>)[key] = MASK_SENTINEL;
        maskedPaths.push(childPath);
      } else {
        (node as Record<string, unknown>)[key] = maskByKey(value, childPath, maskedPaths, secretValues);
      }
    }
    return node;
  }

  return node;
}

/**
 * Pass 2: masks any site anywhere in the tree whose value exactly equals a
 * secret string collected by pass 1 — this is what catches a scalar alias
 * of a masked secret sitting under a non-sensitive key. Sites pass 1 already
 * masked hold MASK_SENTINEL, which is never a member of secretValues (see
 * the guard in maskByKey), so they're skipped here rather than re-added to
 * maskedPaths.
 */
function maskByValue(node: unknown, path: string, maskedPaths: string[], secretValues: Set<string>): unknown {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const item = node[i];
      // A string element sitting directly in a sequence (e.g. `allow:\n  -
      // *pw`) has no key of its own, so the object-branch's `typeof value
      // === 'string' && secretValues.has(value)` check below never runs for
      // it — recursing into a string is a no-op (falls through to the final
      // `return node` with nothing matched). Without this check, a scalar
      // alias landing directly in a sequence leaks the plaintext verbatim.
      if (typeof item === 'string' && secretValues.has(item)) {
        node[i] = MASK_SENTINEL;
        maskedPaths.push(`${path}[${i}]`);
      } else {
        node[i] = maskByValue(item, `${path}[${i}]`, maskedPaths, secretValues);
      }
    }
    return node;
  }

  if (node !== null && typeof node === 'object') {
    for (const key of Object.keys(node as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      const value = (node as Record<string, unknown>)[key];
      if (typeof value === 'string' && secretValues.has(value)) {
        (node as Record<string, unknown>)[key] = MASK_SENTINEL;
        maskedPaths.push(childPath);
      } else {
        (node as Record<string, unknown>)[key] = maskByValue(value, childPath, maskedPaths, secretValues);
      }
    }
    return node;
  }

  return node;
}

export function maskYamlSecrets(content: string): MaskResult {
  let parsed: unknown;
  try {
    parsed = load(content);
  } catch (err) {
    if (err instanceof YAMLException && err.reason === EMPTY_DOCUMENT_REASON) {
      return { maskedContent: '', maskedPaths: [], parseError: false };
    }
    return { maskedContent: '', maskedPaths: [], parseError: true };
  }

  // Defense in depth: parsed can also come back undefined directly (rather
  // than load() throwing) on some inputs/schema configurations — same "valid
  // empty document" verdict applies. dump(undefined) is not exercised as a
  // substitute for "" here since its behavior isn't part of this module's
  // contract.
  if (parsed === undefined) {
    return { maskedContent: '', maskedPaths: [], parseError: false };
  }

  // dump() lives in this same try/catch (not just load()) so an unexpected
  // dumper failure degrades to parseError instead of surfacing as a 500 —
  // fail-closed consistency with the parse-failure path above.
  try {
    const maskedPaths: string[] = [];
    const secretValues = new Set<string>();

    maskByKey(parsed, '', maskedPaths, secretValues);

    // Structural pass: proxy-providers/rule-providers subscription URLs.
    // Deliberately scoped to the actual TOP-LEVEL value only (never a
    // same-named map nested elsewhere) — see maskProviderMapUrls.
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const root = parsed as Record<string, unknown>;
      for (const providersKey of PROVIDERS_KEYS) {
        maskProviderMapUrls(root[providersKey], providersKey, maskedPaths, secretValues);
      }
    }

    if (secretValues.size > 0) {
      maskByValue(parsed, '', maskedPaths, secretValues);
    }

    // lineWidth: -1 disables line folding — a folded long value would
    // corrupt M2b's baseHash-matched round-trip substitution.
    const maskedContent = dump(parsed, { lineWidth: -1 });

    return { maskedContent, maskedPaths, parseError: false };
  } catch {
    return { maskedContent: '', maskedPaths: [], parseError: true };
  }
}
