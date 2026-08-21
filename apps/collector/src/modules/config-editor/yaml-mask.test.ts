import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';
import { MASK_SENTINEL, maskYamlSecrets } from './yaml-mask.js';

describe('maskYamlSecrets', () => {
  it('masks every sensitive key at any depth, arrays included', () => {
    const r = maskYamlSecrets([
      'secret: topsecret',
      'proxies:',
      '  - name: a',
      '    password: p1',
      '    uuid: u-1',
      '  - name: b',
      '    ws-opts:',
      '      headers:',
      '        token: nested-t',
    ].join('\n'));
    expect(r.parseError).toBe(false);
    expect(r.maskedContent).not.toMatch(/topsecret|p1|u-1|nested-t/);
    const count = (r.maskedContent.match(/__ORBIT_MASKED__/g) || []).length;
    expect(count).toBe(4);
    expect(r.maskedPaths).toEqual(expect.arrayContaining([
      'secret',
      'proxies[0].password',
      'proxies[0].uuid',
      'proxies[1].ws-opts.headers.token',
    ]));
  });

  it('non-sensitive values survive verbatim', () => {
    const r = maskYamlSecrets('port: 7890\nmode: rule\n');
    expect(r.maskedContent).toContain('7890');
    expect(r.maskedPaths).toHaveLength(0);
  });

  it('invalid yaml returns parseError with empty content (never leak unparsed text)', () => {
    const r = maskYamlSecrets('a: [unclosed');
    expect(r.parseError).toBe(true);
    expect(r.maskedContent).toBe('');
  });

  it('MASK_SENTINEL is the exact cross-milestone literal', () => {
    expect(MASK_SENTINEL).toBe('__ORBIT_MASKED__');
  });

  it('masks a numeric value under a sensitive key', () => {
    const r = maskYamlSecrets('proxies:\n  - name: a\n    token: 12345\n');
    expect(r.parseError).toBe(false);
    expect(r.maskedContent).not.toMatch(/12345/);
    expect(r.maskedPaths).toEqual(['proxies[0].token']);
  });

  it('masks a sensitive key at top level and separately nested under arrays-of-objects', () => {
    const r = maskYamlSecrets([
      'password: top-secret',
      'servers:',
      '  - name: s1',
      '    password: nested-secret',
      '  - name: s2',
      '    password: nested-secret-2',
    ].join('\n'));
    expect(r.parseError).toBe(false);
    expect(r.maskedContent).not.toMatch(/top-secret|nested-secret|nested-secret-2/);
    expect(r.maskedPaths).toEqual(expect.arrayContaining([
      'password',
      'servers[0].password',
      'servers[1].password',
    ]));
    expect(r.maskedPaths).toHaveLength(3);
  });

  it('a scalar alias under a NON-sensitive key must not leak the aliased secret (reviewer repro)', () => {
    // js-yaml materializes an INDEPENDENT primitive copy of a scalar at
    // each alias site (unlike mapping/sequence aliases, which share one
    // object reference) — so masking-by-key alone only reaches the
    // `password` site and leaves `notes` (not a sensitive key) holding the
    // plaintext verbatim. This is the exact failure mode the two-pass
    // (key-based, then value-based) design in yaml-mask.ts exists to close.
    const r = maskYamlSecrets([
      'password: &pw longsecret1',
      'notes: *pw',
    ].join('\n'));
    expect(r.parseError).toBe(false);
    expect(r.maskedContent).not.toMatch(/longsecret1/);
    expect(r.maskedPaths).toEqual(expect.arrayContaining(['password', 'notes']));
  });

  it('a scalar alias landing inside an array of objects under a non-sensitive key is masked', () => {
    const r = maskYamlSecrets([
      'proxies:',
      '  - name: a',
      '    password: &pw longsecretvalue123',
      '  - name: b',
      '    info: *pw',
    ].join('\n'));
    expect(r.parseError).toBe(false);
    expect(r.maskedContent).not.toMatch(/longsecretvalue123/);
    expect(r.maskedPaths).toEqual(expect.arrayContaining([
      'proxies[0].password',
      'proxies[1].info',
    ]));
  });

  it('a short (<6 char) secret value is masked only at its own key site, not propagated by value', () => {
    // Pins MIN_SECRET_VALUE_LENGTH: a coincidentally-equal short string
    // elsewhere in the document is NOT considered a leaked alias — masking
    // every occurrence of a short/common value would over-mask unrelated
    // fields far more often than it would catch a real short secret.
    const r = maskYamlSecrets([
      'password: abc12',
      'note: abc12',
    ].join('\n'));
    expect(r.parseError).toBe(false);
    expect(r.maskedPaths).toEqual(['password']);
    expect(r.maskedContent).toMatch(/note: abc12/);
  });

  it('value-equality propagation is fail-closed: a coincidentally-equal non-secret field is over-masked', () => {
    // Documents the accepted tradeoff: over-masking a field that merely
    // happens to hold the same >=6-char string as a real secret is
    // acceptable (fail-closed); under-masking a genuine alias is not.
    const r = maskYamlSecrets([
      'password: samevalue123456',
      'description: samevalue123456',
    ].join('\n'));
    expect(r.parseError).toBe(false);
    expect(r.maskedContent).not.toMatch(/samevalue123456/);
    expect(r.maskedPaths).toEqual(expect.arrayContaining(['password', 'description']));
  });

  it('does not fold long non-sensitive values across lines', () => {
    // Pre-C1-rewrite, this pinned js-yaml's dumper `lineWidth: -1` option —
    // its dumper otherwise folds plain scalars into a `>-` block at 80
    // columns, breaking at word boundaries, which would have corrupted
    // M2b's baseHash-matched round-trip substitution. Under the C1 CST
    // rewrite there is no dump step at all — non-masked text is the
    // ORIGINAL source, untouched — so folding is structurally impossible
    // here now. Kept as a regression guard regardless: a long, space-
    // containing value must survive completely unmodified. The value must
    // contain spaces: a single unbroken run of characters has no fold
    // point and would pass even with folding enabled, silently defeating
    // this check.
    const longValue = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const r = maskYamlSecrets(`proxies:\n  - name: a\n    path: ${JSON.stringify(longValue)}\n`);
    expect(r.parseError).toBe(false);
    expect(r.maskedContent).toContain(longValue);
  });

  it('a scalar alias landing directly in a sequence element (not under any key) is masked (reviewer repro I1)', () => {
    // `allow:\n  - *pw` puts the alias string directly as an array element,
    // with no key of its own — the array branch of the value-propagation
    // walker must check the element itself against secretValues, not just
    // recurse into it (recursing into a string is a no-op).
    const r = maskYamlSecrets([
      'password: &pw longsecretvalue123',
      'allow:',
      '  - *pw',
    ].join('\n'));
    expect(r.parseError).toBe(false);
    expect(r.maskedContent).not.toMatch(/longsecretvalue123/);
    expect(r.maskedPaths).toEqual(expect.arrayContaining(['password', 'allow[0]']));
  });

  it('a scalar alias landing directly in a NESTED array element is masked (I1 nested-array variant)', () => {
    const r = maskYamlSecrets([
      'password: &pw longsecretvalue123',
      'groups:',
      '  - name: g1',
      '    members:',
      '      - *pw',
      '      - other',
    ].join('\n'));
    expect(r.parseError).toBe(false);
    expect(r.maskedContent).not.toMatch(/longsecretvalue123/);
    expect(r.maskedPaths).toEqual(expect.arrayContaining(['password', 'groups[0].members[0]']));
    expect(r.maskedContent).toContain('other');
  });

  it('masks hysteria2 obfs-password (I2)', () => {
    const r = maskYamlSecrets([
      'proxies:',
      '  - name: hy2',
      '    type: hysteria2',
      '    obfs: salamander',
      '    obfs-password: obfssecretvalue',
    ].join('\n'));
    expect(r.parseError).toBe(false);
    expect(r.maskedContent).not.toMatch(/obfssecretvalue/);
    expect(r.maskedPaths).toContain('proxies[0].obfs-password');
  });

  it('masks an authentication list wholesale (array under a sensitive key, I2)', () => {
    const r = maskYamlSecrets([
      'listeners:',
      '  - name: mixed',
      '    type: mixed',
      '    authentication:',
      '      - user1:pass1',
      '      - user2:pass2',
    ].join('\n'));
    expect(r.parseError).toBe(false);
    expect(r.maskedContent).not.toMatch(/user1:pass1|user2:pass2/);
    expect(r.maskedPaths).toContain('listeners[0].authentication');
  });

  it('masks proxy-providers.*.url and rule-providers.*.url (subscription tokens, I2)', () => {
    const r = maskYamlSecrets([
      'proxy-providers:',
      '  provider1:',
      '    type: http',
      '    url: "https://sub.example.com/link?token=abcdef123456"',
      '    path: ./proxies/provider1.yaml',
      '    interval: 3600',
      'rule-providers:',
      '  ruleset1:',
      '    type: http',
      '    url: "https://rules.example.com/set?token=zzzzzz999999"',
      '    behavior: classical',
      '    path: ./rules/ruleset1.yaml',
    ].join('\n'));
    expect(r.parseError).toBe(false);
    expect(r.maskedContent).not.toMatch(/token=abcdef123456|token=zzzzzz999999/);
    expect(r.maskedPaths).toEqual(expect.arrayContaining([
      'proxy-providers.provider1.url',
      'rule-providers.ruleset1.url',
    ]));
    // Sibling fields on the same provider entries must survive untouched.
    expect(r.maskedContent).toContain('./proxies/provider1.yaml');
    expect(r.maskedContent).toContain('classical');
  });

  it('masks a provider URL when the provider name itself contains a dot (reviewer repro, residual leak fix)', () => {
    // Path-string matching (`proxy-providers.<name>.url`, re-parsed against
    // a regex) silently under-masks here: a provider named `sub.example`
    // makes the joined path `proxy-providers.sub.example.url`, which is
    // structurally indistinguishable from an extra nesting level. The fix
    // is structural traversal (real object keys, not path strings) — this
    // pins the exact repro from the re-review.
    const r = maskYamlSecrets([
      'proxy-providers:',
      '  sub.example:',
      '    type: http',
      '    url: "https://sub.example.com/link?token=abcdef123456"',
      '    path: ./proxies/sub.example.yaml',
    ].join('\n'));
    expect(r.parseError).toBe(false);
    expect(r.maskedContent).not.toMatch(/token=abcdef123456/);
    expect(r.maskedPaths).toContain('proxy-providers.sub.example.url');
    expect(r.maskedContent).toContain('./proxies/sub.example.yaml');
  });

  it('masks a provider URL when the provider name contains brackets', () => {
    const r = maskYamlSecrets([
      'rule-providers:',
      '  "ruleset[1]":',
      '    type: http',
      '    url: "https://rules.example.com/set?token=zzzzzz999999"',
      '    behavior: classical',
    ].join('\n'));
    expect(r.parseError).toBe(false);
    expect(r.maskedContent).not.toMatch(/token=zzzzzz999999/);
    expect(r.maskedPaths).toContain('rule-providers.ruleset[1].url');
    expect(r.maskedContent).toContain('classical');
  });

  it('does NOT mask a url under a top-level map that is not proxy-providers/rule-providers (scope check)', () => {
    // The structural pass only ever looks at the actual top-level
    // proxy-providers/rule-providers value — an unrelated top-level map
    // whose entries also happen to have a `url` field (e.g. a hypothetical
    // `listeners`/`webhooks`-style block) must not be touched by it.
    const r = maskYamlSecrets([
      'webhooks:',
      '  hook1:',
      '    url: "https://not-a-provider.example.com/should-survive"',
      '    method: POST',
    ].join('\n'));
    expect(r.parseError).toBe(false);
    expect(r.maskedContent).toContain('https://not-a-provider.example.com/should-survive');
    expect(r.maskedPaths).not.toContain('webhooks.hook1.url');
  });

  it('does NOT mask a url under a NESTED map that happens to be named proxy-providers (scope check)', () => {
    // Structural scoping is on the TOP-LEVEL value specifically, not "any
    // map named proxy-providers anywhere in the document".
    const r = maskYamlSecrets([
      'some-other-block:',
      '  proxy-providers:',
      '    nested1:',
      '      url: "https://nested.example.com/should-survive"',
    ].join('\n'));
    expect(r.parseError).toBe(false);
    expect(r.maskedContent).toContain('https://nested.example.com/should-survive');
    expect(r.maskedPaths).not.toContain('some-other-block.proxy-providers.nested1.url');
  });

  it('does NOT mask a WireGuard public-key (I2 negative case — no substring match on "key")', () => {
    const r = maskYamlSecrets([
      'proxies:',
      '  - name: wg',
      '    type: wireguard',
      '    public-key: pubkeyvaluethatlookslikeasecret=',
      '    private-key: privkeyvaluethatlookslikeasecret=',
    ].join('\n'));
    expect(r.parseError).toBe(false);
    // public-key must survive verbatim...
    expect(r.maskedContent).toContain('pubkeyvaluethatlookslikeasecret=');
    expect(r.maskedPaths).not.toContain('proxies[0].public-key');
    // ...while private-key (an exact SENSITIVE_KEYS match) is masked.
    expect(r.maskedContent).not.toMatch(/privkeyvaluethatlookslikeasecret=/);
    expect(r.maskedPaths).toContain('proxies[0].private-key');
  });

  it('an empty document is a valid empty result, not a parse error (M1)', () => {
    const r = maskYamlSecrets('');
    expect(r).toEqual({ maskedContent: '', maskedPaths: [], parseError: false });
  });

  it('a comment-only document is a valid empty result, not a parse error, and preserves the comment (M2b C1 rewrite: no dump, no data to lose)', () => {
    const r = maskYamlSecrets('# comment only\n');
    expect(r).toEqual({ maskedContent: '# comment only\n', maskedPaths: [], parseError: false });
  });

  it('a masked aliased mapping (shared object reference) must not leak through the alias', () => {
    // Anchoring a whole mapping and aliasing it makes js-yaml hand back the
    // *same* object reference at both sites. maskByKey mutates in place, so
    // masking it once at the first path visited masks the alias site too —
    // this path doesn't need the value-propagation pass at all.
    const r = maskYamlSecrets([
      'base: &base',
      '  password: shared-object-secret',
      'proxies:',
      '  - name: a',
      '    auth: *base',
      '  - name: b',
      '    auth: *base',
    ].join('\n'));
    expect(r.parseError).toBe(false);
    expect(r.maskedContent).not.toMatch(/shared-object-secret/);
  });

  // C1 (M2b final review, CRITICAL, root fix): maskedContent is now the
  // ORIGINAL text with only sentinel-range splices, not a js-yaml dump —
  // comments and anchors must survive verbatim, with secrets replaced
  // in-place at their exact source location.
  it('C1: preserves comments and anchors verbatim, replacing secrets in place (root-fix repro)', () => {
    const input = [
      '# top-level comment — device of record',
      'port: 7890 # inline comment on port',
      'proxies:',
      '  - name: a # comment on proxy a',
      '    password: &pw real-secret-value # trailing comment on password',
      '  - name: b',
      '    notes: *pw',
      '# bottom comment',
      '',
    ].join('\n');

    const r = maskYamlSecrets(input);
    expect(r.parseError).toBe(false);
    // Comments survive byte-for-byte, exactly as authored.
    expect(r.maskedContent).toContain('# top-level comment — device of record');
    expect(r.maskedContent).toContain('# inline comment on port');
    expect(r.maskedContent).toContain('# comment on proxy a');
    expect(r.maskedContent).toContain('# trailing comment on password');
    expect(r.maskedContent).toContain('# bottom comment');
    // The anchor sigil survives (only the VALUE range is spliced).
    expect(r.maskedContent).toContain('password: &pw');
    expect(r.maskedContent).toContain('notes: *pw');
    // The secret itself is gone everywhere, including from the alias's
    // resolved value once the masked text is re-parsed.
    expect(r.maskedContent).not.toMatch(/real-secret-value/);
    expect(r.maskedPaths).toEqual(expect.arrayContaining(['proxies[0].password', 'proxies[1].notes']));
    const parsedMasked = load(r.maskedContent) as { proxies: Array<{ password?: string; notes?: string }> };
    expect(parsedMasked.proxies[0].password).toBe(MASK_SENTINEL);
    expect(parsedMasked.proxies[1].notes).toBe(MASK_SENTINEL);
  });

  it('C1: an alias site referencing a masked anchor is left textually untouched but resolves to the sentinel, and its path is recorded', () => {
    const input = ['password: &pw longsecretvalue123', 'notes: *pw'].join('\n') + '\n';
    const r = maskYamlSecrets(input);
    expect(r.parseError).toBe(false);
    // The alias site's own text (`*pw`) is never spliced — only the
    // anchor's Scalar node is a substitution target.
    expect(r.maskedContent).toContain('notes: *pw');
    expect(r.maskedContent).not.toMatch(/longsecretvalue123/);
    expect(r.maskedPaths).toEqual(expect.arrayContaining(['password', 'notes']));
    const parsed = load(r.maskedContent) as { password: string; notes: string };
    expect(parsed.password).toBe(MASK_SENTINEL);
    expect(parsed.notes).toBe(MASK_SENTINEL);
  });

  it('C1: a sensitive key whose value is itself an alias masks the ANCHOR site (wherever it is), not just the alias site', () => {
    // `foo` is not a sensitive key, but `password` (sensitive) aliases it —
    // the anchor's real text location (under `foo`) must still be masked,
    // or the plaintext would leak in the clear right next to a masked
    // `password: *x`.
    const input = ['foo: &x plaintext-leak-value', 'password: *x'].join('\n') + '\n';
    const r = maskYamlSecrets(input);
    expect(r.parseError).toBe(false);
    expect(r.maskedContent).not.toMatch(/plaintext-leak-value/);
    expect(r.maskedContent).toContain('password: *x');
    expect(r.maskedPaths).toContain('password');
  });

  it('C1: containment de-dup (advisor-flagged repro) — an anchor orphaned by an ENCLOSING wholesale mask fails closed rather than shipping a dangling alias', () => {
    // `secret` (sensitive) masks the WHOLE map wholesale (its value is a
    // map, not a scalar) — that map's range covers `inner`'s full content
    // BYTE SPAN, which includes the `&x` anchor marker as ordinary text
    // (even though the nested Scalar node's own `.range` excludes it).
    // `token` is ALSO sensitive and its value is an Alias resolving to that
    // same nested scalar — structurally CONTAINED inside `secret`'s
    // wholesale-masked range. Two things are pinned here:
    // (1) containment de-dup — without dropping the contained (inner)
    //     range before splicing, the right-to-left splice corrupts (the
    //     inner range's offsets go stale once the outer range spanning it
    //     is replaced);
    // (2) once the outer map is replaced, the `&x` anchor it contained is
    //     GONE — `token: *x` is now a dangling alias with no matching
    //     anchor anywhere in the document. This is a pathological,
    //     adversarial-authoring shape (an anchor nested inside one
    //     sensitive value, aliased from a DIFFERENT, unrelated sensitive
    //     key elsewhere), not a realistic mihomo config — the correct,
    //     safe outcome is FAIL CLOSED (parseError: true, no content
    //     shown), never a corrupted-but-parseable document.
    const input = ['secret:', '  inner: &x topvalue123', 'token: *x'].join('\n') + '\n';
    const r = maskYamlSecrets(input);
    expect(r).toEqual({ maskedContent: '', maskedPaths: [], parseError: true });
  });

  it('C1: a wholesale-masked map is NOT the last key — the following sibling key stays on its own line (trailing-newline repro)', () => {
    // `secret`'s value-map's CST range extends through its own trailing
    // `\n` (verified empirically against the installed `yaml` package) —
    // that newline is simultaneously "the end of this node" and "the only
    // separator before `after-key`". Blindly replacing the whole range with
    // a bare sentinel (no newline of its own) glues `after-key:` onto the
    // sentinel's line, corrupting the document structurally, not just
    // cosmetically.
    const input = ['secret:', '  inner: topsecretvalue123', 'after-key: still-here'].join('\n') + '\n';
    const r = maskYamlSecrets(input);
    expect(r.parseError).toBe(false);
    expect(r.maskedContent).not.toMatch(/topsecretvalue123/);
    const lines = r.maskedContent.split('\n');
    expect(lines).toContain('after-key: still-here');
    const parsed = load(r.maskedContent) as { secret: string; 'after-key': string };
    expect(parsed.secret).toBe(MASK_SENTINEL);
    expect(parsed['after-key']).toBe('still-here');
  });

  it('C1: does not collect a range nested inside another collected range, reverse direction (outer decided after inner)', () => {
    // Mirror of the first containment test with document order reversed:
    // `password` (sensitive) is masked first, as a plain SCALAR nested
    // inside the (at that point unmasked-as-a-whole) `inner` map. Then
    // `secret` (sensitive, appearing later) is an Alias resolving to that
    // SAME `inner` map — now requesting the WHOLE map (which already
    // contains the just-masked `password` scalar) be masked wholesale too.
    // Unlike the previous test, the anchor (`&b`) sits on the MAP itself
    // (`inner: &b`) rather than on a scalar nested inside it — and a
    // node's own anchor marker is excluded from its own range (verified
    // empirically). So wholesale-masking `inner` via `secret`'s alias
    // replaces only the map's CONTENT (`password: nestedsecretvalue`),
    // leaving `&b` intact — no dangling alias, unlike the previous test.
    const input = ['inner: &b', '  password: nestedsecretvalue', 'secret: *b'].join('\n') + '\n';
    const r = maskYamlSecrets(input);
    expect(r.parseError).toBe(false);
    expect(r.maskedContent).not.toMatch(/nestedsecretvalue/);
    const parsed = load(r.maskedContent) as { inner: string; secret: string };
    // `inner` collapsed into the wholesale sentinel (its map content was
    // entirely replaced), and `secret: *b` resolves via the alias to that
    // exact same (now-scalar) node — both must read back as the sentinel.
    expect(parsed.inner).toBe(MASK_SENTINEL);
    expect(parsed.secret).toBe(MASK_SENTINEL);
  });
});
