import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';
import { MASK_SENTINEL } from './yaml-mask.js';
import { prepareApply, SELF_LOCK_FIELDS, VERIFY_KEYS, type ApplyInput } from './apply-pipeline.js';

const HASH = 'agent-hash-v1';
const OTHER_HASH = 'agent-hash-v2';

// A representative base config.yaml: comments, plain fields, a self-lock
// field, a would-be-masked secret, and a non-primitive VERIFY-adjacent
// field (dns, an object) to exercise the verify-extraction whitelist.
const BASE_YAML = [
  '# base config — device of record',
  'port: 7890',
  'socks-port: 7891',
  'mixed-port: 7892',
  'mode: rule',
  'log-level: info',
  'allow-lan: true',
  'external-controller: 127.0.0.1:9090',
  "secret: base-secret-value",
  'bind-address: "*"',
  'external-ui: ui',
  'password: real-password-value',
  'dns:',
  '  enable: true',
  '  nameserver:',
  '    - 8.8.8.8',
].join('\n') + '\n';

function input(content: string, baseHash = HASH): ApplyInput {
  return { backendId: 1, content, baseHash };
}

describe('prepareApply', () => {
  it('exports the binding SELF_LOCK_FIELDS and VERIFY_KEYS contracts', () => {
    expect(SELF_LOCK_FIELDS).toEqual(['external-controller', 'secret', 'bind-address', 'external-ui']);
    expect(VERIFY_KEYS).toEqual(['port', 'socks-port', 'mixed-port', 'mode', 'log-level', 'allow-lan']);
  });

  // Scenario 1 (+ amendment: comment survival is now part of this scenario).
  // Built on the full base document (all self-lock fields intact) so this
  // isolates sentinel resubstitution + comment survival, not a spurious
  // self-lock rejection from an incomplete submitted document.
  it('scenario 1: resubstitutes a sentinel with the base value and preserves comments verbatim', () => {
    const submitted = '# user comment above port\n' + BASE_YAML
      .replace('password: real-password-value', 'password: ' + MASK_SENTINEL)
      + '# trailing comment\n';

    const r = prepareApply(input(submitted), BASE_YAML, HASH);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.prepared.finalContent).not.toContain(MASK_SENTINEL);
    expect(r.prepared.finalContent).toContain('# user comment above port');
    expect(r.prepared.finalContent).toContain('# trailing comment');
    const parsedFinal = load(r.prepared.finalContent) as Record<string, unknown>;
    expect(parsedFinal.password).toBe('real-password-value');
  });

  // Scenario 2
  it('scenario 2: sentinel path missing in base -> MASK_PATH_MISSING', () => {
    const submitted = 'brand-new-field: ' + MASK_SENTINEL + '\n';
    const r = prepareApply(input(submitted), BASE_YAML, HASH);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection).toEqual({ code: 'MASK_PATH_MISSING', path: 'brand-new-field' });
  });

  // Scenario 3a: changed self-lock field
  it('scenario 3a: changing a self-lock field value -> SELF_LOCK_FIELD_CHANGED', () => {
    const submitted = BASE_YAML.replace('secret: base-secret-value', 'secret: attacker-supplied-value');
    const r = prepareApply(input(submitted), BASE_YAML, HASH);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection).toEqual({ code: 'SELF_LOCK_FIELD_CHANGED', field: 'secret' });
  });

  // Scenario 3b: newly-added self-lock field (absent in base)
  it('scenario 3b: adding a self-lock field the base did not have -> SELF_LOCK_FIELD_CHANGED', () => {
    const base = BASE_YAML.split('\n').filter((l) => !l.startsWith('external-ui:')).join('\n');
    const submitted = base + 'external-ui: attacker-ui\n';
    const r = prepareApply(input(submitted), base, HASH);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection).toEqual({ code: 'SELF_LOCK_FIELD_CHANGED', field: 'external-ui' });
  });

  // Scenario 3c: self-lock field present in base, submitted equal (including
  // via sentinel resolving back to the base value) -> pass.
  it('scenario 3c: self-lock field unchanged (equal value) passes, including via sentinel resubstitution', () => {
    const submittedLiteral = BASE_YAML; // byte-identical resubmission
    const r1 = prepareApply(input(submittedLiteral), BASE_YAML, HASH);
    expect(r1.ok).toBe(true);

    const submittedSentinel = BASE_YAML.replace('secret: base-secret-value', `secret: ${MASK_SENTINEL}`);
    const r2 = prepareApply(input(submittedSentinel), BASE_YAML, HASH);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    const parsedFinal = load(r2.prepared.finalContent) as Record<string, unknown>;
    expect(parsedFinal.secret).toBe('base-secret-value');
  });

  // Scenario 4
  it('scenario 4: baseHash mismatch vs latest agent hash -> BASE_HASH_STALE', () => {
    const r = prepareApply(input(BASE_YAML, HASH), BASE_YAML, OTHER_HASH);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection).toEqual({ code: 'BASE_HASH_STALE' });
  });

  // Scenario 5
  it('scenario 5: invalid YAML -> YAML_INVALID', () => {
    const r = prepareApply(input('a: [unclosed'), BASE_YAML, HASH);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe('YAML_INVALID');
  });

  // Scenario 6
  it('scenario 6: verify extraction takes only present primitive whitelist keys, not objects', () => {
    const r = prepareApply(input(BASE_YAML), BASE_YAML, HASH);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.prepared.verify).toEqual({
      port: 7890,
      'socks-port': 7891,
      'mixed-port': 7892,
      mode: 'rule',
      'log-level': 'info',
      'allow-lan': true,
    });
    expect(r.prepared.verify).not.toHaveProperty('dns');
  });

  // Scenario 7
  it('scenario 7: hand-typed sentinel literal at a path the base does not have -> MASK_PATH_MISSING (no silent pass)', () => {
    const submitted = BASE_YAML + `totally-new-key: ${MASK_SENTINEL}\n`;
    const r = prepareApply(input(submitted), BASE_YAML, HASH);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection).toEqual({ code: 'MASK_PATH_MISSING', path: 'totally-new-key' });
  });

  // Amendment: comment survival, explicit — comments scattered around and
  // interleaved with the sentinel line must survive byte-for-byte. Built on
  // the full base document (all self-lock fields intact) so this exercises
  // comment preservation in isolation, not a self-lock rejection.
  it('preserves comments scattered throughout the document, not just adjacent to the sentinel', () => {
    const submitted = '# top comment\n' + BASE_YAML
      .replace('port: 7890', 'port: 7890 # inline comment on port')
      .replace('password: real-password-value', '# comment before password\npassword: ' + MASK_SENTINEL + '\n# comment after password')
      .replace('mode: rule', 'mode: rule # inline comment on mode')
      + '# bottom comment\n';
    const r = prepareApply(input(submitted), BASE_YAML, HASH);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.prepared.finalContent).toContain('# top comment');
    expect(r.prepared.finalContent).toContain('# inline comment on port');
    expect(r.prepared.finalContent).toContain('# comment before password');
    expect(r.prepared.finalContent).toContain('# comment after password');
    expect(r.prepared.finalContent).toContain('# inline comment on mode');
    expect(r.prepared.finalContent).toContain('# bottom comment');
  });

  // Amendment: anchor/alias survival — anchors unrelated to any sentinel
  // must be untouched by resubstitution. Built on the full base document so
  // all self-lock fields stay intact.
  it('leaves unrelated anchors and aliases untouched by sentinel resubstitution', () => {
    const proxyGroups = [
      'proxy-groups:',
      '  - name: auto',
      '    proxies: &plist',
      '      - a',
      '      - b',
      '  - name: fallback',
      '    proxies: *plist',
    ].join('\n') + '\n';
    const submitted = proxyGroups + BASE_YAML.replace('password: real-password-value', 'password: ' + MASK_SENTINEL);
    const r = prepareApply(input(submitted), BASE_YAML, HASH);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.prepared.finalContent).toContain('proxies: &plist');
    expect(r.prepared.finalContent).toContain('proxies: *plist');
    const parsedFinal = load(r.prepared.finalContent) as Record<string, unknown>;
    expect(parsedFinal.password).toBe('real-password-value');
  });

  // Amendment: quote-safety — base value containing a single quote, a
  // colon, and unicode must be inserted safely and round-trip exactly.
  it('inserts a base value containing a quote, a colon, and unicode safely (round-trips exactly)', () => {
    const trickyValue = "it's a test: 日本語 value";
    const base = BASE_YAML + `tricky: ${JSON.stringify(trickyValue)}\n`;
    const submitted = base.replace(`tricky: ${JSON.stringify(trickyValue)}`, 'tricky: ' + MASK_SENTINEL);
    const r = prepareApply(input(submitted), base, HASH);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.prepared.finalContent).not.toContain(MASK_SENTINEL);
    const parsedFinal = load(r.prepared.finalContent) as Record<string, unknown>;
    expect(parsedFinal.tricky).toBe(trickyValue);
  });

  // Guard: a sentinel wrapped in the submitter's own quotes must not be
  // double-corrupted (quote-inside-quote) — the replacement must cover the
  // whole quoted scalar, not just the inner literal.
  it('handles a quoted sentinel literal without corrupting the surrounding quotes', () => {
    const submitted = BASE_YAML.replace('password: real-password-value', `password: "${MASK_SENTINEL}"`);
    const r = prepareApply(input(submitted), BASE_YAML, HASH);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsedFinal = load(r.prepared.finalContent) as Record<string, unknown>;
    expect(parsedFinal.password).toBe('real-password-value');
  });

  // Round-2 structural guarantee: an anchored sentinel that is also aliased
  // elsewhere is now handled correctly, not rejected. The alias site (`*pw`)
  // is a distinct Alias CST node — never a Scalar node — so it is never an
  // independent substitution target; only the anchor's own Scalar node gets
  // its `.value` mutated in place (never replaced as an object, which would
  // detach the anchor and break the alias). The alias then resolves the new
  // value for free on reparse.
  it('resubstitutes an anchored sentinel and lets an alias elsewhere resolve the new value naturally', () => {
    const submitted = BASE_YAML.replace('password: real-password-value', `password: &pw ${MASK_SENTINEL}`) + 'notes: *pw\n';
    const r = prepareApply(input(submitted), BASE_YAML, HASH);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.prepared.finalContent).not.toContain(MASK_SENTINEL);
    expect(r.prepared.finalContent).toContain('password: &pw');
    expect(r.prepared.finalContent).toContain('notes: *pw');
    const parsedFinal = load(r.prepared.finalContent) as Record<string, unknown>;
    expect(parsedFinal.password).toBe('real-password-value');
    expect(parsedFinal.notes).toBe('real-password-value');
  });

  /**
   * Returns every line of `text` that contains a `#` — a rough
   * over-inclusive "comment line" filter (it doesn't distinguish a real
   * comment from a `#` inside a quoted value), deliberately conservative:
   * good enough to assert a secret never shows up on ANY line that could
   * plausibly be read as containing a comment.
   */
  function linesWithHash(text: string): string[] {
    return text.split('\n').filter((line) => line.includes('#'));
  }

  // CRITICAL fix repro, round 1 (reviewer's exact scenario) — now a
  // regression test with UPDATED expectations. Round 1's flat count check
  // was gameable: an anchor+alias sentinel (2 tree entries, 1 text
  // occurrence — a deficit) combined with a sentinel literal sitting inside
  // a comment (1 text occurrence, 0 tree entries — an excess) canceled out,
  // and round 1's naive left-to-right splice spliced the SECOND entry's base
  // value into the comment line — a permanent plaintext leak. The round-2
  // CST-based rewrite closes this by construction: the comment is never a
  // Scalar node, so it is never a splice target at all, REGARDLESS of any
  // count. The submission is now ACCEPTED, with the sentinel literal left
  // untouched, inert, inside the comment, and the real secret resolved
  // correctly at `a` (and, via the alias, at `b`) — never inside a comment.
  it('CRITICAL regression (round 1 cancel-game repro): comment-embedded sentinel is left untouched, never receives the secret', () => {
    const base = ['a: shared-secret-value', 'b: shared-secret-value'].join('\n') + '\n';
    const submitted = [`a: &s ${MASK_SENTINEL}`, 'b: *s', `# ${MASK_SENTINEL}`].join('\n') + '\n';
    const r = prepareApply(input(submitted), base, HASH);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.prepared.finalContent).toContain(`# ${MASK_SENTINEL}`);
    for (const line of linesWithHash(r.prepared.finalContent)) {
      expect(line).not.toContain('shared-secret-value');
    }
    const parsedFinal = load(r.prepared.finalContent) as Record<string, unknown>;
    expect(parsedFinal.a).toBe('shared-secret-value');
    expect(parsedFinal.b).toBe('shared-secret-value');
  });

  // CRITICAL fix repro, round 2 (reviewer's exact decoy-apostrophe
  // scenario). Round 1's hand-rolled quote-tracking text scanner
  // (`isSentinelInComment`, since deleted) treated a bare apostrophe inside
  // an UNQUOTED plain scalar (`don't`) as entering single-quote state — a
  // real YAML parser never does this (a `'` is only a quote delimiter as the
  // very FIRST character of a scalar; mid-scalar it's just a character) —
  // which desynced the scanner's state so it missed the REAL comment that
  // followed, letting the sentinel-in-a-comment slip through as if it were a
  // value. The round-2 CST rewrite has no quote-tracking to desync in the
  // first place: `yaml`'s real parser determines comment-vs-value
  // correctly regardless of what a plain scalar earlier on the line
  // contains.
  it('CRITICAL regression (round 2 decoy-apostrophe repro): an apostrophe in a plain scalar does not desync comment detection', () => {
    const submitted = BASE_YAML
      .replace('password: real-password-value', 'password: ' + MASK_SENTINEL)
      + `note: don't # ${MASK_SENTINEL}\n`;
    const r = prepareApply(input(submitted), BASE_YAML, HASH);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.prepared.finalContent).toContain(`# ${MASK_SENTINEL}`);
    for (const line of linesWithHash(r.prepared.finalContent)) {
      expect(line).not.toContain('real-password-value');
    }
    const parsedFinal = load(r.prepared.finalContent) as Record<string, unknown>;
    expect(parsedFinal.password).toBe('real-password-value');
    expect(parsedFinal.note).toBe("don't");
  });

  // A sentinel-literal SUBSTRING embedded inside a larger quoted value (not
  // an exact match for the whole scalar) is not a real sentinel node at all
  // — the CST walk only ever matches a Scalar whose ENTIRE value equals
  // MASK_SENTINEL — so it is simply not a substitution target and passes
  // through unchanged, same treatment as a comment-embedded occurrence.
  it('leaves a sentinel-literal substring inside a larger quoted value untouched (not an exact-match sentinel node)', () => {
    const submitted = BASE_YAML.replace(
      'password: real-password-value',
      `password: "note # ${MASK_SENTINEL} tail"`,
    );
    const r = prepareApply(input(submitted), BASE_YAML, HASH);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.prepared.finalContent).toContain(MASK_SENTINEL);
    const parsedFinal = load(r.prepared.finalContent) as Record<string, unknown>;
    expect(parsedFinal.password).toBe(`note # ${MASK_SENTINEL} tail`);
  });

  // Non-scalar sentinel value: M2a's masking can replace a whole list (e.g.
  // `authentication:`) with the scalar sentinel. Resubstitution must restore
  // the original array, not just scalar values.
  it('resubstitutes a sentinel whose base value is a non-scalar (array) correctly', () => {
    const authBlock = ['authentication:', '  - user1:pass1', '  - user2:pass2'].join('\n') + '\n';
    const base = BASE_YAML + authBlock;
    const submitted = BASE_YAML + 'authentication: ' + MASK_SENTINEL + '\n';
    const r = prepareApply(input(submitted), base, HASH);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.prepared.finalContent).not.toContain(MASK_SENTINEL);
    const parsedFinal = load(r.prepared.finalContent) as Record<string, unknown>;
    expect(parsedFinal.authentication).toEqual(['user1:pass1', 'user2:pass2']);
  });

  it('rejects malformed base version content defensively (cannot safely resubstitute or self-lock compare)', () => {
    const r = prepareApply(input(BASE_YAML), 'a: [unclosed', HASH);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe('YAML_INVALID');
  });

  // Identity-aware array resolution (M2b Task 9 fix-round). M2b Task 9's web
  // table editors added row reorder/delete for proxies/proxy-groups/rules,
  // making positional (index-based) sentinel resubstitution reachable and
  // exploitable by an ordinary user action, not just a crafted submission.
  describe('identity-aware array resolution (named proxies/proxy-groups rows)', () => {
    const baseTwoProxies = [
      'proxies:',
      '  - name: proxy-a',
      '    type: ss',
      '    server: a.example.com',
      '    port: 8388',
      '    password: secret-for-a',
      '  - name: proxy-b',
      '    type: ss',
      '    server: b.example.com',
      '    port: 8389',
      '    password: secret-for-b',
    ].join('\n') + '\n';

    it('reorder: swapping two masked proxy rows resolves each to ITS OWN base secret, not the other row\'s', () => {
      // Submitted with proxy-b FIRST, proxy-a SECOND (base has a first, b
      // second) — the exact cross-contamination repro: pre-fix, positional
      // lockstep would pair submitted index 0 (proxy-b, masked) against
      // base index 0 (proxy-a's secret), and vice versa.
      const submitted = [
        'proxies:',
        '  - name: proxy-b',
        '    type: ss',
        '    server: b.example.com',
        '    port: 8389',
        `    password: ${MASK_SENTINEL}`,
        '  - name: proxy-a',
        '    type: ss',
        '    server: a.example.com',
        '    port: 8388',
        `    password: ${MASK_SENTINEL}`,
      ].join('\n') + '\n';

      const r = prepareApply(input(submitted), baseTwoProxies, HASH);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.prepared.finalContent).not.toContain(MASK_SENTINEL);
      const parsedFinal = load(r.prepared.finalContent) as { proxies: Array<{ name: string; password: string }> };
      const byName = Object.fromEntries(parsedFinal.proxies.map((p) => [p.name, p.password]));
      expect(byName['proxy-a']).toBe('secret-for-a');
      expect(byName['proxy-b']).toBe('secret-for-b');
    });

    it('delete: removing row 0 leaves the remaining masked row resolved to its OWN secret, not the deleted row\'s', () => {
      // Submitted has only proxy-b (proxy-a deleted) — pre-fix, positional
      // lockstep would pair submitted index 0 (proxy-b, masked) against
      // base index 0 (proxy-a's secret).
      const submitted = [
        'proxies:',
        '  - name: proxy-b',
        '    type: ss',
        '    server: b.example.com',
        '    port: 8389',
        `    password: ${MASK_SENTINEL}`,
      ].join('\n') + '\n';

      const r = prepareApply(input(submitted), baseTwoProxies, HASH);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const parsedFinal = load(r.prepared.finalContent) as { proxies: Array<{ name: string; password: string }> };
      expect(parsedFinal.proxies).toHaveLength(1);
      expect(parsedFinal.proxies[0].name).toBe('proxy-b');
      expect(parsedFinal.proxies[0].password).toBe('secret-for-b');
    });

    it('renamed row with a masked field -> MASK_PATH_MISSING (fails closed, does not fall back to position)', () => {
      const submitted = [
        'proxies:',
        '  - name: proxy-a-renamed',
        '    type: ss',
        '    server: a.example.com',
        '    port: 8388',
        `    password: ${MASK_SENTINEL}`,
        '  - name: proxy-b',
        '    type: ss',
        '    server: b.example.com',
        '    port: 8389',
        `    password: ${MASK_SENTINEL}`,
      ].join('\n') + '\n';

      const r = prepareApply(input(submitted), baseTwoProxies, HASH);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.rejection).toEqual({ code: 'MASK_PATH_MISSING', path: 'proxies[0].password' });
    });

    it('duplicate names in the SUBMITTED array -> ambiguous -> MASK_PATH_MISSING', () => {
      const submitted = [
        'proxies:',
        '  - name: proxy-a',
        '    type: ss',
        '    server: a.example.com',
        '    port: 8388',
        `    password: ${MASK_SENTINEL}`,
        '  - name: proxy-a',
        '    type: ss',
        '    server: a2.example.com',
        '    port: 8390',
        '    password: literal-new-password',
      ].join('\n') + '\n';

      const r = prepareApply(input(submitted), baseTwoProxies, HASH);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.rejection.code).toBe('MASK_PATH_MISSING');
      if (r.rejection.code !== 'MASK_PATH_MISSING') return;
      expect(r.rejection.path).toBe('proxies[0].password');
    });

    it('duplicate names in the BASE array -> ambiguous -> MASK_PATH_MISSING', () => {
      const baseWithDuplicateName = [
        'proxies:',
        '  - name: proxy-a',
        '    type: ss',
        '    server: a.example.com',
        '    port: 8388',
        '    password: secret-1',
        '  - name: proxy-a',
        '    type: ss',
        '    server: a2.example.com',
        '    port: 8390',
        '    password: secret-2',
      ].join('\n') + '\n';
      const submitted = [
        'proxies:',
        '  - name: proxy-a',
        '    type: ss',
        '    server: a.example.com',
        '    port: 8388',
        `    password: ${MASK_SENTINEL}`,
      ].join('\n') + '\n';

      const r = prepareApply(input(submitted), baseWithDuplicateName, HASH);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.rejection).toEqual({ code: 'MASK_PATH_MISSING', path: 'proxies[0].password' });
    });

    it('unrenamed, unreordered masked rows still resolve correctly (no false rejection)', () => {
      const submitted = [
        'proxies:',
        '  - name: proxy-a',
        '    type: ss',
        '    server: a.example.com',
        '    port: 8388',
        `    password: ${MASK_SENTINEL}`,
        '  - name: proxy-b',
        '    type: ss',
        '    server: b.example.com',
        '    port: 8389',
        `    password: ${MASK_SENTINEL}`,
      ].join('\n') + '\n';

      const r = prepareApply(input(submitted), baseTwoProxies, HASH);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const parsedFinal = load(r.prepared.finalContent) as { proxies: Array<{ name: string; password: string }> };
      const byName = Object.fromEntries(parsedFinal.proxies.map((p) => [p.name, p.password]));
      expect(byName['proxy-a']).toBe('secret-for-a');
      expect(byName['proxy-b']).toBe('secret-for-b');
    });

    it('plain positional behavior regression: a non-array sentinel is unaffected', () => {
      // scenario 1 in miniature — confirms the identity-aware branch is
      // scoped to array elements and does not change scalar-field handling.
      const submitted = BASE_YAML.replace('password: real-password-value', 'password: ' + MASK_SENTINEL);
      const r = prepareApply(input(submitted), BASE_YAML, HASH);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const parsedFinal = load(r.prepared.finalContent) as Record<string, unknown>;
      expect(parsedFinal.password).toBe('real-password-value');
    });

    it('plain positional behavior regression: an unnamed (plain scalar) array element keeps positional resolution', () => {
      // dns.nameserver is a plain string list — no `name` identity exists,
      // so reordering it is expected to keep matching by position (this
      // fix only changes resolution for named-mapping elements).
      const base = [
        'dns:',
        '  enable: true',
        '  nameserver:',
        '    - 8.8.8.8',
        `    - masked-nameserver-secret`,
      ].join('\n') + '\n';
      const submitted = [
        'dns:',
        '  enable: true',
        '  nameserver:',
        '    - 8.8.8.8',
        `    - ${MASK_SENTINEL}`,
      ].join('\n') + '\n';
      const r = prepareApply(input(submitted), base, HASH);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const parsedFinal = load(r.prepared.finalContent) as { dns: { nameserver: string[] } };
      expect(parsedFinal.dns.nameserver).toEqual(['8.8.8.8', 'masked-nameserver-secret']);
    });
  });
});
