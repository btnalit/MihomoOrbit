/**
 * YAML secret masking — M2a, rewritten M2b final-review (C1)
 *
 * ROOT FIX (M2b whole-branch final review, C1 — CRITICAL): the M1/M2a
 * implementation parsed with js-yaml and re-serialized with `dump()`, which
 * discards comments, expands anchors and normalizes formatting. That made
 * `maskedContent` a comment-free, anchor-free reconstruction — so EVERY
 * downstream comment-preservation layer (apply-pipeline.ts's CST splice,
 * the web's Task-8 `parseDocument(maskedContent)`-then-patch flow) operated
 * on already-comment-free text, no matter how carefully those layers
 * themselves preserved formatting. There was nothing left to preserve.
 *
 * This rewrite mirrors apply-pipeline.ts's own technique (read that module
 * first — its docstring is the canonical explanation of why range-splicing
 * on the ORIGINAL text, not tree-dump, is the only sound approach here):
 * parse with the `yaml` (eemeli) package's position-aware CST
 * (`parseDocument` + per-node `range`), collect the exact byte ranges of
 * every Scalar (or whole Map/Seq, for a non-scalar secret) that must be
 * masked, and splice `MASK_SENTINEL` into the ORIGINAL source text at those
 * ranges, right-to-left. Comments, anchors, aliases, key order and all
 * other formatting survive BY CONSTRUCTION — the walk below simply never
 * touches any byte outside a collected range. js-yaml is no longer used
 * anywhere in this module (it remains a dependency for apply-pipeline.ts's
 * base-version parsing and round-trip safety net, which are unaffected by
 * this rewrite).
 *
 * MASK_SENTINEL is a cross-milestone contract: M2b's apply path resubstitutes
 * this exact literal with the original value (matched by baseHash), so it
 * must never change once agents/collectors in the field depend on it.
 *
 * Parse failures never leak the original (possibly-sensitive) text: any
 * parse error (`doc.errors.length > 0`), or an unexpected failure in the
 * masking/splicing step below, or the post-splice re-parse safety net
 * failing, all degrade to maskedContent '' with parseError: true. Safer to
 * show nothing than to risk masking failing silently on malformed input.
 *
 * An empty or comment-only document (`doc.contents === null`, no errors) is
 * a VALID empty result, not malformed input — but unlike the pre-rewrite
 * behavior (which returned an empty maskedContent even for a comment-only
 * document, since js-yaml's value tree has nothing to dump), the ORIGINAL
 * text is returned verbatim here: a comment-only file has nothing to mask
 * (no Scalar nodes exist at all), so there is nothing unsafe about showing
 * it, and doing so preserves the user's comments instead of silently
 * discarding them.
 *
 * Three-pass masking, identical in spirit to the pre-rewrite js-yaml
 * version (see the historical structure this mirrors), but operating on
 * CST nodes/ranges instead of a mutated value tree + re-dump:
 *
 * Pass 1 (key-based + structural provider urls): walks the CST top-down.
 * At each Map, a child reached via a case-insensitive SENSITIVE_KEYS match
 * masks that child's WHOLE range as one unit (a Scalar's own range, or an
 * entire Map/Seq's range when the sensitive key's value is non-scalar,
 * e.g. `authentication:` holding a list) — never recurses further into an
 * already-decided-masked subtree. Separately, the actual top-level
 * `proxy-providers`/`rule-providers` maps are walked structurally (real
 * CST object traversal, never a reconstructed path string — see the
 * providers-key comment below for why) to mask each provider entry's `url`
 * Scalar specifically. Both contribute matched STRING values (>=
 * MIN_SECRET_VALUE_LENGTH) to `secretValues` for pass 2.
 *
 * A sensitive key (or provider url) whose value is itself an Alias node
 * (e.g. `password: *anchoredElsewhere`) is resolved via `Alias.resolve(doc)`
 * — which returns the SAME node object the anchor site was parsed into, not
 * a copy (verified empirically against this repo's installed `yaml`
 * version) — and the RESOLVED node's range is what actually gets masked
 * (the alias site itself has no independent text to blank, but its own
 * path is still recorded in maskedPaths).
 *
 * Pass 2 (value-equality propagation): after pass 1 completes, if any
 * secret values were collected, walks EVERY remaining (not-yet-masked)
 * Scalar node in the tree and masks any whose string value exactly equals
 * a collected secret — this is what catches a scalar alias sitting under a
 * NON-sensitive key (js-yaml's value tree gave scalar aliases independent
 * primitive copies at each site with no shared-reference way to find them;
 * the CST equivalent is this same string-equality scan, since a *bare*
 * duplicated scalar has no CST-level relationship to its twin either). Only
 * STRING secrets propagate this way (see the documented residual below).
 * Deliberately fail-closed: a coincidentally-equal non-secret value is
 * over-masked rather than risking under-masking a real alias.
 *
 * Pass 3 (alias awareness): walks every Alias node in the tree and checks
 * whether `Alias.resolve(doc)` returns a node already in the masked set
 * (from pass 1 or 2) — if so, the alias's OWN path is added to
 * maskedPaths (never a range: an alias site's source text, e.g. `*pw`, never
 * contains the secret itself, so there is nothing to blank there — the
 * anchor's own masked range already keeps the plaintext out of the
 * document). This is what keeps `notes: *pw` (aliasing a masked `password:
 * &pw ...`) discoverable/revealable in the editor UI even though its own
 * site's text is untouched.
 *
 * All three passes skip recursing into any node already in the masked set
 * (a whole Map/Seq masked by pass 1, or a Scalar masked by pass 1/2) — both
 * because there is nothing further to find inside it, and because
 * collecting a range NESTED inside an already-collected range would corrupt
 * the right-to-left splice (an inner range's offsets become invalid once
 * the outer range spanning it has already been replaced). As defense in
 * depth beyond the per-pass skip (alias resolution can otherwise discover a
 * node whose ancestor gets independently masked by an unrelated decision,
 * in either document order), `spliceRanges` also explicitly drops any
 * collected range that is a subset of another before splicing — CST node
 * ranges from the same tree are always either nested or disjoint, never
 * partially overlapping, so containment is the only case to guard.
 *
 * Documented residuals (carried over from the pre-rewrite version, still
 * accurate under the CST rewrite):
 * - Only STRING secrets are value-propagated (pass 2). A numeric scalar
 *   alias of a numeric secret is NOT propagated — masking every occurrence
 *   of an equal *number* anywhere in the document would corrupt unrelated
 *   ports/counts/timeouts, and a numeric secret living under a
 *   non-sensitive key is judged out of this threat model.
 * - The MIN_SECRET_VALUE_LENGTH floor exists to avoid over-masking trivial
 *   values (short placeholder strings, enum-like tags) that happen to
 *   collide.
 * - A sensitive key masked WHOLESALE (its value is a Map/Seq, e.g.
 *   `authentication:` holding a list) does not propagate ANY of its
 *   individual elements' values into secretValues — matches the pre-rewrite
 *   js-yaml behavior exactly (the whole-value replace branch never
 *   inspected element values either), so an alias elsewhere referencing one
 *   specific element inside such a wholesale-masked collection is not
 *   independently discoverable. Pre-existing, not a rewrite regression.
 */
import { parseDocument, isMap, isSeq, isScalar, isAlias } from 'yaml';
import type { Document } from 'yaml';

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
// lives at PROVIDERS_KEY.<name>.url — handled STRUCTURALLY below (real CST
// object traversal, keyed off the actual top-level map's own items) rather
// than by reconstructing/matching the `.`-joined path string: maskedPaths
// entries join keys with `.` purely for human-readable reporting, and a
// provider name containing a literal `.` (e.g. `sub.example`) or `[`/`]`
// makes the joined string structurally ambiguous — indistinguishable from
// an extra nesting level — so re-parsing it to decide "is this a provider
// entry" silently under-masks any provider name that isn't a single clean
// path segment. Structural traversal has no such blind spot: provider names
// may contain any character at all.
const PROVIDERS_KEYS = ['proxy-providers', 'rule-providers'] as const;

// Floor for cross-site value-equality propagation (pass 2) — a collected
// secret shorter than this is judged too likely to collide with unrelated
// legitimate values, so it is masked only at its own key site.
const MIN_SECRET_VALUE_LENGTH = 6;

interface WalkCtx {
  doc: Document;
  /** CST node objects (Scalar | YAMLMap | YAMLSeq) whose whole range has
   *  been decided as masked — reference-keyed, since the CST gives every
   *  real (non-alias) location in the tree exactly one node object. Used
   *  both to skip re-descending into an already-masked subtree and, in
   *  pass 3, to test whether an Alias resolves to a masked node. */
  maskedNodes: Set<object>;
  ranges: Array<[number, number]>;
  paths: string[];
  secretValues: Set<string>;
}

function keyString(keyNode: unknown): string {
  return isScalar(keyNode) ? String((keyNode as { value: unknown }).value) : String(keyNode);
}

/** Registers `node`'s whole source range as masked (idempotent — a node
 *  already in `maskedNodes` is left alone) and, for a string-valued Scalar,
 *  feeds pass 2's value-equality propagation. Does NOT touch `paths` —
 *  callers own recording whichever logical path(s) this masking decision
 *  corresponds to, since a single physical range can be reached via an
 *  alias site whose own path differs from the range's own location. */
function maskWholeRange(node: unknown, ctx: WalkCtx): void {
  if (node === null || typeof node !== 'object') return;
  if (ctx.maskedNodes.has(node)) return;
  ctx.maskedNodes.add(node);
  const range = (node as { range?: [number, number, number] | null }).range;
  if (range) {
    ctx.ranges.push([range[0], range[1]]);
  }
  if (
    isScalar(node) &&
    typeof node.value === 'string' &&
    node.value.length >= MIN_SECRET_VALUE_LENGTH &&
    node.value !== MASK_SENTINEL
  ) {
    ctx.secretValues.add(node.value);
  }
}

/** A site (sensitive-key value, or a provider's `url`) that must be masked
 *  regardless of its node kind. An Alias here is resolved first — the
 *  ANCHOR's node is what actually holds the plaintext, so that is what gets
 *  its range masked, while `path` (this site's own location) is what gets
 *  recorded in maskedPaths. */
function maskSensitiveSite(node: unknown, path: string, ctx: WalkCtx): void {
  if (node === null || node === undefined) return;
  if (isAlias(node)) {
    const target = node.resolve(ctx.doc);
    if (target !== undefined) {
      maskWholeRange(target, ctx);
    }
    ctx.paths.push(path);
    return;
  }
  maskWholeRange(node, ctx);
  ctx.paths.push(path);
}

/** Pass 1: generic key-based walk. Decides masking at the PARENT (Map) level
 *  — a sensitive-keyed child is masked wholesale via maskSensitiveSite and
 *  never recursed into further; everything else recurses normally. Bare
 *  Scalars and Aliases reached without a sensitive-key decision are no-ops
 *  here (a Scalar has nothing to decide on its own; an Alias is handled in
 *  pass 3, once the masked set is final). */
function walkKeys(node: unknown, path: string, ctx: WalkCtx): void {
  if (node === null || node === undefined) return;

  if (isMap(node)) {
    for (const pair of node.items) {
      const key = keyString(pair.key);
      const childPath = path ? `${path}.${key}` : key;
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        maskSensitiveSite(pair.value, childPath, ctx);
      } else {
        walkKeys(pair.value, childPath, ctx);
      }
    }
    return;
  }

  if (isSeq(node)) {
    node.items.forEach((item, i) => walkKeys(item, `${path}[${i}]`, ctx));
    return;
  }

  // Scalar / Alias — nothing to decide at this level.
}

/** Resolves an Alias to its target node; passes any other node through
 *  unchanged. Used by the provider-url pass so an aliased url is still
 *  recognized as string-valued (and thus maskable) without hand-rolling a
 *  second alias branch there. */
function resolveIfAlias(node: unknown, doc: Document): unknown {
  return isAlias(node) ? node.resolve(doc) : node;
}

/** Structural provider-url pass: masks the actual TOP-LEVEL
 *  `proxy-providers`/`rule-providers` maps' `<name>.url` entries — real CST
 *  traversal of `root`'s own items, so it can never reach into a same-named
 *  map nested elsewhere in the document (see PROVIDERS_KEYS's comment).
 *  Narrower than the generic sensitive-key handling: only a url whose
 *  (alias-resolved) value is a plain string is masked, matching the
 *  pre-rewrite behavior exactly. */
function maskProviderUrls(root: unknown, ctx: WalkCtx): void {
  if (!isMap(root)) return;
  for (const providersKey of PROVIDERS_KEYS) {
    const providersPair = root.items.find((p) => isScalar(p.key) && keyString(p.key) === providersKey);
    const providersMap = providersPair?.value;
    if (!isMap(providersMap)) continue;
    for (const providerPair of providersMap.items) {
      const providerName = keyString(providerPair.key);
      const entryNode = providerPair.value;
      if (!isMap(entryNode)) continue;
      const urlPair = entryNode.items.find((p) => isScalar(p.key) && keyString(p.key) === 'url');
      if (!urlPair) continue;
      const urlNode = urlPair.value;
      const resolved = resolveIfAlias(urlNode, ctx.doc);
      if (!isScalar(resolved) || typeof resolved.value !== 'string' || resolved.value === MASK_SENTINEL) continue;
      maskSensitiveSite(urlNode, `${providersKey}.${providerName}.url`, ctx);
    }
  }
}

/** Shared generic walker for passes 2 and 3: stops (does not recurse
 *  further) the instant it reaches a node already in `maskedNodes` — both
 *  because nothing further needs finding beneath a wholesale-masked
 *  subtree, and to guarantee no range gets collected nested inside another
 *  (see the module docstring's containment note). */
function walkGeneric(
  node: unknown,
  path: string,
  ctx: WalkCtx,
  onScalar: (node: import('yaml').Scalar, path: string) => void,
  onAlias: (node: import('yaml').Alias, path: string) => void,
): void {
  if (node === null || node === undefined) return;
  if (typeof node === 'object' && ctx.maskedNodes.has(node)) return;

  if (isAlias(node)) {
    onAlias(node, path);
    return;
  }
  if (isScalar(node)) {
    onScalar(node, path);
    return;
  }
  if (isMap(node)) {
    for (const pair of node.items) {
      const key = keyString(pair.key);
      const childPath = path ? `${path}.${key}` : key;
      walkGeneric(pair.value, childPath, ctx, onScalar, onAlias);
    }
    return;
  }
  if (isSeq(node)) {
    node.items.forEach((item, i) => walkGeneric(item, `${path}[${i}]`, ctx, onScalar, onAlias));
    return;
  }
}

/** Pass 2: value-equality propagation — see the module docstring. */
function maskByValueEquality(root: unknown, ctx: WalkCtx): void {
  walkGeneric(
    root,
    '',
    ctx,
    (scalarNode, path) => {
      if (typeof scalarNode.value === 'string' && ctx.secretValues.has(scalarNode.value)) {
        maskWholeRange(scalarNode, ctx);
        ctx.paths.push(path);
      }
    },
    () => {
      /* aliases are pass 3's concern */
    },
  );
}

/** Pass 3: alias awareness — see the module docstring. */
function collectMaskedAliasPaths(root: unknown, ctx: WalkCtx): void {
  walkGeneric(
    root,
    '',
    ctx,
    () => {
      /* scalars already fully resolved by passes 1-2 */
    },
    (aliasNode, path) => {
      const target = aliasNode.resolve(ctx.doc);
      if (target !== undefined && ctx.maskedNodes.has(target)) {
        ctx.paths.push(path);
      }
    },
  );
}

/**
 * Splices MASK_SENTINEL into `content` at every collected range,
 * right-to-left so earlier offsets stay valid as later ranges are replaced
 * first. Ranges that are a strict subset of another collected range are
 * dropped first (defense in depth beyond the per-pass "don't recurse into
 * an already-masked node" skip — see the module docstring) since splicing
 * both would corrupt the outer replacement's already-substituted text.
 *
 * A block-style Map/Seq's range (unlike a plain scalar's) extends through
 * its OWN trailing line break — verified empirically: masking `authentication:`
 * wholesale when it is NOT the document's last key showed the sibling key
 * that immediately follows getting glued onto the same line as the
 * sentinel, because that trailing `\n` is simultaneously "the end of this
 * node's content" and "the only separator before the next sibling". The fix
 * generalizes to every range, not just collections: whenever the ORIGINAL
 * text being replaced itself ended in a line break, that exact line break is
 * preserved immediately after the sentinel. This is a no-op for the common
 * plain-scalar case (a scalar's range never includes a trailing newline).
 */
function spliceRanges(content: string, ranges: Array<[number, number]>): string {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const kept: Array<[number, number]> = [];
  for (const r of sorted) {
    const containedInKept = kept.some((k) => r[0] >= k[0] && r[1] <= k[1]);
    if (!containedInKept) kept.push(r);
  }

  const rightToLeft = [...kept].sort((a, b) => b[0] - a[0]);
  let result = content;
  for (const [start, end] of rightToLeft) {
    const trailingNewline = result.slice(start, end).match(/(\r\n|\n)$/)?.[0] ?? '';
    result = result.slice(0, start) + MASK_SENTINEL + trailingNewline + result.slice(end);
  }
  return result;
}

export function maskYamlSecrets(content: string): MaskResult {
  const doc = parseDocument(content);
  if (doc.errors.length > 0) {
    return { maskedContent: '', maskedPaths: [], parseError: true };
  }

  // A valid empty or comment-only document has no Scalar nodes to mask at
  // all — nothing unsafe about returning it verbatim, and doing so keeps
  // the user's comments instead of silently discarding them (the
  // pre-rewrite js-yaml behavior, which had nothing left to dump).
  if (doc.contents === null || doc.contents === undefined) {
    return { maskedContent: content, maskedPaths: [], parseError: false };
  }

  try {
    const ctx: WalkCtx = {
      doc,
      maskedNodes: new Set<object>(),
      ranges: [],
      paths: [],
      secretValues: new Set<string>(),
    };

    walkKeys(doc.contents, '', ctx);
    maskProviderUrls(doc.contents, ctx);

    if (ctx.secretValues.size > 0) {
      maskByValueEquality(doc.contents, ctx);
    }

    collectMaskedAliasPaths(doc.contents, ctx);

    const maskedContent = spliceRanges(content, ctx.ranges);

    // Fail-closed backstop: confirm the spliced text is still valid YAML.
    // Mirrors the pre-rewrite module's try/catch-around-dump philosophy —
    // any splice-arithmetic bug class degrades to parseError instead of
    // shipping content that might not even parse (or, worse, parses into
    // something unintended).
    //
    // `doc.errors` alone is NOT sufficient here — verified empirically: a
    // dangling alias (its anchor's own node got wholesale-masked away as
    // part of an ENCLOSING map/seq being replaced, e.g. an anchor nested
    // inside a sensitive-keyed value that a DIFFERENT sensitive key also
    // aliases wholesale — a pathological, adversarial-authoring edge case,
    // not a realistic mihomo config shape) parses with ZERO `.errors` and
    // only throws once something actually RESOLVES the alias, e.g.
    // `.toJS()`. Calling it here (result discarded — only its throw/no-throw
    // matters) closes that gap; the throw is caught by this function's own
    // outer try/catch below, degrading to the same parseError: true.
    const verifyDoc = parseDocument(maskedContent);
    if (verifyDoc.errors.length > 0) {
      return { maskedContent: '', maskedPaths: [], parseError: true };
    }
    verifyDoc.toJS();

    // De-duplicated: a sensitive key whose OWN value is an Alias (e.g.
    // `secret: *x` where `secret` is itself sensitive) has its path pushed
    // once by pass 1 (maskSensitiveSite's alias branch) AND once more by
    // pass 3's independent, unconditional walk over every Alias node in the
    // tree (which has no way to know pass 1 already decided this exact
    // alias site) — harmless (both pushes agree), but a plain Set dedup
    // keeps maskedPaths free of exact-duplicate entries regardless of which
    // pass(es) contributed a given path.
    return { maskedContent, maskedPaths: Array.from(new Set(ctx.paths)), parseError: false };
  } catch {
    return { maskedContent: '', maskedPaths: [], parseError: true };
  }
}
