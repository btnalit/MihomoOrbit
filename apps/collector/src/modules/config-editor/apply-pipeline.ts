/**
 * Config apply pipeline — M2b Task 5
 *
 * BINDING AMENDMENT (M2a final review, I4): this pipeline's OUTPUT
 * (`finalContent`, what the agent eventually writes to disk) is NEVER
 * js-yaml `dump()` output. Dumping and re-serializing the submitted document
 * would destroy comments, expand anchors/aliases, and normalize key order —
 * unacceptable for a user's first edit permanently mangling their
 * config.yaml. Instead, `finalContent` is the user's SUBMITTED TEXT with
 * ONLY sentinel occurrences replaced, spliced in textually at their exact
 * source byte ranges. Everything else in the submitted text (comments,
 * anchors, aliases, formatting, key order) survives BY CONSTRUCTION, because
 * it is simply never touched.
 *
 * STRUCTURAL GUARANTEE (round 2 rewrite — see progress.md fix-round history
 * for what round 1 got wrong): sentinel discovery and replacement positions
 * come from the `yaml` package's position-aware CST (`parseDocument` +
 * per-node `range`), not from scanning the raw text for the literal
 * `MASK_SENTINEL` string. This closes the exploit class BY CONSTRUCTION
 * rather than by pattern-matching:
 * - A comment is never a Scalar/Alias node in the CST — `# __ORBIT_MASKED__`
 *   inside a comment is simply never visited by the walk below, so it can
 *   never be a substitution target and never receives a splice. The
 *   sentinel literal is left sitting in the comment, inert (harmless: it is
 *   a fixed public string, not a secret).
 * - An alias site (`*s`) is a distinct `Alias` node, never a `Scalar` node,
 *   even when it resolves to a value equal to MASK_SENTINEL — so it is never
 *   independently collected or spliced. Only the anchor's own Scalar node
 *   (`&s __ORBIT_MASKED__`) is a substitution target; replacing it in the
 *   source text leaves `&s` intact with a new value, and the alias `*s`
 *   naturally resolves to that new value when the result is re-parsed.
 * - Round 1's hand-rolled quote/comment-state text scanner
 *   (`isSentinelInComment`) is deleted, along with the flat "does the
 *   sentinel-literal count in the text equal the sentinel-node count in the
 *   tree" check it fed — hand-rolling YAML's comment/quote grammar was an
 *   ongoing bypass source (round 1 was itself a fix for an earlier exploit,
 *   and was broken again by a plain apostrophe in an unrelated
 *   comment-adjacent scalar desyncing the scanner's quote-tracking state). A
 *   text occurrence that isn't backed by a real Scalar CST node simply
 *   cannot be found by the walk below in the first place — there is no
 *   count to get wrong.
 *
 * Mechanics:
 * 1. Parse the SUBMITTED yaml with `yaml`'s `parseDocument` (CST, not
 *    `js-yaml`) — any parse error rejects YAML_INVALID. Parse the BASE
 *    version content with `js-yaml` `load()` (plain value tree; the base is
 *    never spliced or displayed, only read for values, so no CST is needed).
 * 2. Walk the submitted CST and the base value tree together, structurally
 *    in lockstep (not via path-string reconstruction — see the note on
 *    `collectAndSubstitute` for why path-string re-lookup is
 *    correctness-hazardous). Every Scalar node whose `.value` is exactly
 *    MASK_SENTINEL is recorded with its exact source byte range (from the
 *    CST — already includes surrounding quote characters for a quoted
 *    scalar, so no separate quote-detection logic is needed) and the
 *    structurally-corresponding base value (or "absent"). The SAME walk
 *    mutates the CST in place — setting the sentinel Scalar node's `.value`
 *    directly to the base value — so `doc.toJS()` afterward yields the
 *    fully-resubstituted EXPECTED tree directly, without a second walk. This
 *    MUST be an in-place `.value` mutation on the EXISTING node, never a
 *    replacement of the node object (e.g. via `doc.createNode()` swapped
 *    into the parent slot): an anchored scalar's alias sites resolve by
 *    live reference to that exact node object, and replacing the object
 *    detaches the anchor, breaking every alias to it (`yaml` throws
 *    "Unresolved alias" on the next `toJS()`/`toString()` call). Mutating
 *    `.value` keeps the node's identity — and therefore the anchor — intact,
 *    so every alias site resolves the new value for free.
 * 3. Any sentinel-valued node whose structurally-corresponding base value is
 *    absent rejects MASK_PATH_MISSING — a hand-typed sentinel literal at a
 *    path the base doesn't have is never silently accepted.
 * 4. Each collected range is spliced into the ORIGINAL submitted text
 *    RIGHT-TO-LEFT (sorted by range start, descending) so earlier offsets
 *    stay valid as later-in-document ranges are replaced first. The
 *    replacement text is a YAML-safe inline rendering of the base value:
 *    strings are single-quoted (`'` doubled), numbers/booleans/null are
 *    inserted as their literal token, and non-scalar base values (e.g. an
 *    `authentication:` list M2a's masker replaces wholesale with the scalar
 *    sentinel) are rendered via a forced single-line flow-style
 *    `js-yaml` dump.
 * 5. Final safety net: the spliced `finalContent` is re-parsed with
 *    `js-yaml` and (a) deep-equality-compared against the EXPECTED tree from
 *    step 2, and (b) checked to contain MASK_SENTINEL nowhere at all. Either
 *    check failing rejects YAML_INVALID — this is the backstop for any
 *    splicing bug class, structural-guarantee bugs included.
 *
 * Self-lock compare runs on the EXPECTED tree from step 2 (the resubstituted
 * tree), never on the raw submitted tree — a sentinel over `secret` that
 * resolves back to the base value is "unchanged" (pass); a literal new value
 * the user typed is "changed" (reject).
 *
 * Documented residual: the document-order assumption round 1 relied on for
 * its now-deleted count check (`Object.keys()` iteration order matching
 * source order, which JS does not guarantee for integer-like keys) no longer
 * applies to anything — this rewrite never pairs entries by counted order,
 * only by exact CST byte range, so that residual is fully closed, not just
 * narrowed.
 *
 * AMENDMENT (M2b Task 9 fix-round): identity-aware array resolution.
 * M2b Task 9 (web) added row reorder/delete to the proxies/proxy-groups/
 * rules table editors. That made a latent hazard in step 2 reachable: for a
 * plain YAML sequence, "structurally in lockstep" originally meant matching
 * submitted index `i` against base index `i`. If a row carrying a masked
 * sentinel field (e.g. a proxy's `password: __ORBIT_MASKED__`) is moved to
 * a different index, or an earlier row is deleted out from under it,
 * positional lockstep resubstitutes that sentinel against a DIFFERENT
 * row's base value — i.e. one proxy's real secret silently gets written
 * into another proxy's field. Silent and wrong, not merely rejected.
 *
 * Fix: `collectAndSubstitute`'s array branch now resolves a submitted
 * element's base counterpart BY NAME, not by index, whenever that element
 * is a mapping with a plain scalar `name` key — the Mihomo convention for
 * every `proxies`/`proxy-groups` entry. It finds the base array element
 * whose `name` equals the submitted element's `name`, then continues the
 * walk against THAT element regardless of either one's array position.
 * Fails closed (treated identically to "absent" -> `MASK_PATH_MISSING`,
 * the pre-existing rejection code — no new one introduced) when: no base
 * element has a matching name (a renamed row with a still-masked field, or
 * a brand-new row carrying a hand-typed sentinel literal — the user must
 * re-enter/reveal the secret in either case, which is correct, not a
 * regression); or the name is ambiguous — duplicated within the submitted
 * array, within the base array, or both — since guessing which duplicate a
 * sentinel belongs to would reintroduce exactly the cross-contamination
 * this fix exists to close. An array element with no resolvable `name`
 * (a plain scalar — the `rules` array, a `dns.nameserver` list, a
 * proxy-group's own `proxies` member-name list) is unaffected: it keeps
 * the original positional resolution, since it never had a stable identity
 * to key off in the first place. This produces no separate "expected tree"
 * computation to keep in sync — `expectedTree` (used by both the self-lock
 * compare and the round-trip safety net) is `doc.toJS()` read directly off
 * the SAME CST that this identity-aware walk already mutated in place, so
 * it reflects the corrected resolution automatically.
 */
import { load, dump, YAMLException } from 'js-yaml';
import { parseDocument, isMap, isSeq, isScalar } from 'yaml';
import { MASK_SENTINEL } from './yaml-mask.js';

export interface ApplyInput {
  backendId: number;
  content: string;
  baseHash: string;
}

export type ApplyRejection =
  | { code: 'YAML_INVALID'; detail: string }
  | { code: 'MASK_PATH_MISSING'; path: string }
  | { code: 'SELF_LOCK_FIELD_CHANGED'; field: string }
  | { code: 'BASE_HASH_STALE' };

export interface ApplyPrepared {
  finalContent: string;
  verify: Record<string, unknown>;
}

export const SELF_LOCK_FIELDS = ['external-controller', 'secret', 'bind-address', 'external-ui'] as const;
export const VERIFY_KEYS = ['port', 'socks-port', 'mixed-port', 'mode', 'log-level', 'allow-lan'] as const;

type ApplyResult = { ok: true; prepared: ApplyPrepared } | { ok: false; rejection: ApplyRejection };

// Mirrors yaml-mask.ts's handling of the same js-yaml 5.2.3 quirk: load()
// throws (rather than returning undefined, as 4.x did) for an empty or
// comment-only document. That is a valid empty document, not malformed
// input. Not exported from yaml-mask.ts, so mirrored here — re-verify on any
// js-yaml version bump (see progress.md item 3). Only used for parsing the
// BASE version content — the submitted content is parsed with the `yaml`
// package instead, which reports an empty/comment-only document as
// `contents: null` with zero errors, no equivalent workaround needed.
const EMPTY_DOCUMENT_REASON = 'expected a document, but the input is empty';

function safeLoad(content: string): { ok: true; value: unknown } | { ok: false } {
  try {
    const value = load(content);
    return { ok: true, value };
  } catch (err) {
    if (err instanceof YAMLException && err.reason === EMPTY_DOCUMENT_REASON) {
      return { ok: true, value: undefined };
    }
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

interface SentinelEntry {
  path: string;
  range: [number, number];
  present: boolean;
  baseValue: unknown;
}

/**
 * Walks the submitted CST and the base value tree together, in lockstep, and:
 * - records every Scalar node whose value is exactly MASK_SENTINEL (path,
 *   exact source byte range, and the structurally-corresponding base value
 *   or "absent") into `entries`;
 * - mutates that Scalar node's `.value` IN PLACE (never replaces the node
 *   object — see the module docstring for why that breaks anchors) to the
 *   base value, so that after the full walk `doc.toJS()` yields the
 *   fully-resubstituted tree directly, with every alias resolving correctly.
 *
 * An Alias node (`*s`) is never a Scalar node, even when it resolves to a
 * value equal to MASK_SENTINEL — `isScalar` returns false for it, so it is
 * silently skipped here: correct, because there is no text of its own to
 * splice at the alias site, and mutating the anchor's Scalar node (reached
 * separately, at its own path) already fixes every alias site for free.
 *
 * Deliberately does NOT reconstruct a path string and re-look-it-up against
 * the base tree: yaml-mask.ts documents exactly why that's hazardous (a
 * `.`-joined path is structurally ambiguous whenever a key itself contains
 * `.` or `[`/`]`, e.g. a proxy-provider named `sub.example`). Walking both
 * trees in lockstep has no such blind spot — the base counterpart is always
 * the actual sibling value, never a re-parsed guess. `pathDisplay` is built
 * purely for the MASK_PATH_MISSING error message, never used for lookup.
 *
 * Array elements resolve their base counterpart BY NAME, not by index,
 * whenever the element is a mapping with a plain scalar `name` key (see the
 * module-level "identity-aware array resolution" amendment above) — plain
 * scalar array elements (no identity available) keep positional resolution.
 */
function collectAndSubstitute(
  node: unknown,
  baseValue: unknown,
  present: boolean,
  pathDisplay: string,
  entries: SentinelEntry[],
): void {
  if (node == null) return;

  if (isScalar(node)) {
    if (node.value === MASK_SENTINEL) {
      const range = node.range;
      if (range) {
        entries.push({ path: pathDisplay, range: [range[0], range[1]], present, baseValue });
        if (present) {
          node.value = baseValue;
        }
      }
    }
    return;
  }

  if (isMap(node)) {
    const baseIsRecord = isRecord(baseValue);
    for (const pair of node.items) {
      const keyNode = pair.key;
      const keyStr = isScalar(keyNode) ? String(keyNode.value) : String(keyNode);
      const childPresent = baseIsRecord && Object.prototype.hasOwnProperty.call(baseValue, keyStr);
      const childBase = childPresent ? (baseValue as Record<string, unknown>)[keyStr] : undefined;
      const childPath = pathDisplay ? `${pathDisplay}.${keyStr}` : keyStr;
      collectAndSubstitute(pair.value, childBase, childPresent, childPath, entries);
    }
    return;
  }

  if (isSeq(node)) {
    const baseIsArray = Array.isArray(baseValue);
    const baseArray = baseIsArray ? (baseValue as unknown[]) : [];
    // Identity-aware resolution needs both sides' name -> count maps up
    // front (not recomputed per item) so a duplicate name anywhere in
    // either array is detected and fails closed, not just a duplicate that
    // happens to appear before the item currently being resolved.
    const baseNameCounts = countNamedRecords(baseArray);
    const submittedNameCounts = countSubmittedNames(node.items);

    node.items.forEach((item, i) => {
      const childPath = `${pathDisplay}[${i}]`;
      const itemName = submittedMapName(item);

      if (itemName !== undefined) {
        // Named element (the proxies/proxy-groups row convention) — match
        // BY NAME within this array, never by index, so a reordered or
        // partially-deleted array still resubstitutes each row's OWN base
        // value. Unambiguous only when the name resolves to exactly one
        // element on BOTH sides; anything else fails closed as "absent"
        // (same MASK_PATH_MISSING path the rest of this function already
        // uses for a path the base doesn't have) rather than guessing.
        const unambiguous =
          (submittedNameCounts.get(itemName) ?? 0) === 1 && (baseNameCounts.get(itemName) ?? 0) === 1;
        const childBase = unambiguous
          ? baseArray.find((b) => isNamedRecord(b) && b.name === itemName)
          : undefined;
        collectAndSubstitute(item, childBase, unambiguous, childPath, entries);
        return;
      }

      // No identity available (not a mapping, or a mapping without a plain
      // scalar `name`) — unchanged positional resolution: a plain scalar
      // list (`rules`, a `dns.nameserver` array, a proxy-group's own
      // `proxies` member-name list) never had a stable identity to key off.
      const childPresent = baseIsArray && i < baseArray.length;
      const childBase = childPresent ? baseArray[i] : undefined;
      collectAndSubstitute(item, childBase, childPresent, childPath, entries);
    });
    return;
  }

  // Alias nodes (and any other node kind) — never a substitution target;
  // see the doc comment above for why this is correct for aliases.
}

/** True if `value` is a base-tree object with a plain string `name` — the
 *  Mihomo convention used to identify a `proxies`/`proxy-groups` array
 *  element regardless of its position (see collectAndSubstitute's array
 *  branch and the module-level amendment for why position alone is
 *  unsafe). */
function isNamedRecord(value: unknown): value is Record<string, unknown> & { name: string } {
  return isRecord(value) && typeof value.name === 'string';
}

/** Extracts the scalar `name` value of a SUBMITTED CST map node, if any —
 *  the identity key used to resolve this element's base counterpart by
 *  name rather than by array position. Returns undefined for anything that
 *  isn't a mapping with a plain-string `name` key, which also naturally
 *  covers `name` itself being sentinel-masked: matching against the
 *  literal sentinel string finds no real base counterpart, which fails
 *  closed via the ordinary "absent" path (MASK_PATH_MISSING) rather than
 *  risking a wrong-value leak. */
function submittedMapName(node: unknown): string | undefined {
  if (!isMap(node)) return undefined;
  for (const pair of node.items) {
    const keyNode = pair.key;
    const keyStr = isScalar(keyNode) ? String(keyNode.value) : String(keyNode);
    if (keyStr !== 'name') continue;
    const valueNode = pair.value;
    return isScalar(valueNode) && typeof valueNode.value === 'string' ? valueNode.value : undefined;
  }
  return undefined;
}

/** Counts, per name, how many elements of a BASE array are identity-named
 *  records (see isNamedRecord) — used to fail closed on an ambiguous
 *  (duplicate-name) match instead of guessing which duplicate a sentinel
 *  belongs to. */
function countNamedRecords(arr: unknown[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of arr) {
    if (isNamedRecord(item)) {
      counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
    }
  }
  return counts;
}

/** Same idea as countNamedRecords, but over a SUBMITTED CST array's items
 *  (only the ones with a resolvable scalar `name`, per submittedMapName). */
function countSubmittedNames(items: readonly unknown[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const name = submittedMapName(item);
    if (name !== undefined) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return counts;
}

/** Single-quote a string per the amendment's rule, doubling any embedded `'`. */
function singleQuoteYaml(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Renders a base value as YAML-safe inline text suitable for splicing in
 * place of a scalar sentinel's byte range. Strings are always single-quoted;
 * numbers/booleans/null are inserted as their literal token (amendment's
 * explicit rule). Non-scalar values (object/array — M2a's masker can
 * replace a whole list like `authentication:` with the scalar sentinel) are
 * rendered with a forced single-line flow-style dump, which is syntactically
 * valid in exactly the position a scalar occupied.
 */
function yamlSafeInline(value: unknown): string {
  if (typeof value === 'string') {
    // Embedded raw newlines don't round-trip safely under single-quote
    // folding rules (YAML folds them per line-folding semantics, not as
    // literal preservation) — double-quoted escaping is unambiguous instead.
    if (/[\n\r]/.test(value)) {
      return JSON.stringify(value);
    }
    return singleQuoteYaml(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null || value === undefined) {
    return 'null';
  }
  return dump(value, { flowLevel: 0, lineWidth: -1 }).trim();
}

/**
 * Splices replacement texts into the ORIGINAL submitted text at exact byte
 * ranges, right-to-left (descending by range start) so replacing a later
 * range never invalidates the still-to-be-processed offsets of an earlier
 * one.
 */
function spliceByRanges(text: string, replacements: { range: [number, number]; replacementText: string }[]): string {
  const sorted = [...replacements].sort((a, b) => b.range[0] - a.range[0]);
  let result = text;
  for (const r of sorted) {
    result = result.slice(0, r.range[0]) + r.replacementText + result.slice(r.range[1]);
  }
  return result;
}

/** True if MASK_SENTINEL appears as a value anywhere in the tree (any depth). */
function containsSentinelValue(node: unknown): boolean {
  if (node === MASK_SENTINEL) return true;
  if (Array.isArray(node)) return node.some(containsSentinelValue);
  if (isRecord(node)) return Object.values(node).some(containsSentinelValue);
  return false;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.valueOf() === b.valueOf();
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

export function prepareApply(input: ApplyInput, baseVersionContent: string, latestAgentHash: string): ApplyResult {
  const doc = parseDocument(input.content);
  if (doc.errors.length > 0) {
    return {
      ok: false,
      rejection: { code: 'YAML_INVALID', detail: `submitted content is not valid YAML: ${doc.errors[0].message}` },
    };
  }

  const baseLoad = safeLoad(baseVersionContent);
  if (!baseLoad.ok) {
    return { ok: false, rejection: { code: 'YAML_INVALID', detail: 'base version content is not valid YAML' } };
  }
  const baseTree = baseLoad.value;

  // --- Sentinel resubstitution (structural, CST-range-based) ---
  const entries: SentinelEntry[] = [];
  collectAndSubstitute(doc.contents, baseTree, true, '', entries);

  for (const entry of entries) {
    if (!entry.present) {
      return { ok: false, rejection: { code: 'MASK_PATH_MISSING', path: entry.path } };
    }
  }

  // The CST mutations above already produced the fully-resubstituted tree.
  const expectedTree = doc.toJS();

  const replacements = entries.map((entry) => ({
    range: entry.range,
    replacementText: yamlSafeInline(entry.baseValue),
  }));
  const finalContent = spliceByRanges(input.content, replacements);

  // Final safety net: re-parse the spliced text and confirm it matches the
  // EXPECTED tree exactly, and contains the sentinel literal nowhere. Catches
  // any splicing bug class, not just the ones the mechanics above
  // specifically defend against.
  const finalLoad = safeLoad(finalContent);
  if (!finalLoad.ok || !deepEqual(finalLoad.value, expectedTree) || containsSentinelValue(finalLoad.value)) {
    return {
      ok: false,
      rejection: { code: 'YAML_INVALID', detail: 'sentinel resubstitution did not produce a consistent document' },
    };
  }

  // --- Self-lock compare (on the RESUBSTITUTED expected tree) ---
  // A non-mapping top-level document (e.g. the whole file is a YAML list or
  // a bare scalar) falls back to {} here — no self-lock/verify keys can
  // exist on it either way, so the loops below simply find nothing to flag.
  const baseRecord = isRecord(baseTree) ? baseTree : {};
  const finalRecord = isRecord(expectedTree) ? expectedTree : {};
  for (const field of SELF_LOCK_FIELDS) {
    const baseHas = Object.prototype.hasOwnProperty.call(baseRecord, field);
    const finalHas = Object.prototype.hasOwnProperty.call(finalRecord, field);
    if (!baseHas && !finalHas) continue;
    if (!baseHas && finalHas) {
      return { ok: false, rejection: { code: 'SELF_LOCK_FIELD_CHANGED', field } };
    }
    if (baseHas && !deepEqual(baseRecord[field], finalHas ? finalRecord[field] : undefined)) {
      return { ok: false, rejection: { code: 'SELF_LOCK_FIELD_CHANGED', field } };
    }
  }

  // --- Staleness ---
  if (input.baseHash !== latestAgentHash) {
    return { ok: false, rejection: { code: 'BASE_HASH_STALE' } };
  }

  // --- Verify extraction (from the FINAL resubstituted content) ---
  // I2 fix (M2b final-review): `mode`/`log-level` are lowercased here so a
  // case-difference-only edit (e.g. `mode: Rule` vs. mihomo's own
  // lower-case `"rule"` in GET /configs) never causes the agent's
  // post-apply health-gate verify comparison to spuriously mismatch and
  // roll back an otherwise-successful apply. Mirrored on the agent side
  // (configapply/apply.go's looseEqual, via strings.EqualFold) so BOTH ends
  // of the comparison are case-insensitive for these enum-like string
  // fields — lowercasing only here would still fail if mihomo's actual
  // reported value happened to differ in case from this lowercased one.
  // Scoped to these two keys only: `port`/`socks-port`/`mixed-port` are
  // numeric and `allow-lan` is boolean, neither ever needs case handling.
  const VERIFY_KEYS_CASE_INSENSITIVE = new Set<(typeof VERIFY_KEYS)[number]>(['mode', 'log-level']);
  const verify: Record<string, unknown> = {};
  for (const key of VERIFY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(finalRecord, key)) continue;
    const value = finalRecord[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      verify[key] = typeof value === 'string' && VERIFY_KEYS_CASE_INSENSITIVE.has(key) ? value.toLowerCase() : value;
    }
  }

  return { ok: true, prepared: { finalContent, verify } };
}
