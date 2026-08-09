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
import { dump, load } from 'js-yaml';

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
]);

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
      node[i] = maskByKey(node[i], `${path}[${i}]`, maskedPaths, secretValues);
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
      node[i] = maskByValue(node[i], `${path}[${i}]`, maskedPaths, secretValues);
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
  } catch {
    return { maskedContent: '', maskedPaths: [], parseError: true };
  }

  // dump() lives in this same try/catch (not just load()) so an unexpected
  // dumper failure degrades to parseError instead of surfacing as a 500 —
  // fail-closed consistency with the parse-failure path above.
  try {
    const maskedPaths: string[] = [];
    const secretValues = new Set<string>();

    maskByKey(parsed, '', maskedPaths, secretValues);
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
