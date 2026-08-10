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
    node.items.forEach((item, i) => {
      const childPresent = baseIsArray && i < baseValue.length;
      const childBase = childPresent ? baseValue[i] : undefined;
      const childPath = `${pathDisplay}[${i}]`;
      collectAndSubstitute(item, childBase, childPresent, childPath, entries);
    });
    return;
  }

  // Alias nodes (and any other node kind) — never a substitution target;
  // see the doc comment above for why this is correct for aliases.
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
  const verify: Record<string, unknown> = {};
  for (const key of VERIFY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(finalRecord, key)) continue;
    const value = finalRecord[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      verify[key] = value;
    }
  }

  return { ok: true, prepared: { finalContent, verify } };
}
