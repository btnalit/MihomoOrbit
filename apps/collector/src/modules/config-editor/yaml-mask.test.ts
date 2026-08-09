import { describe, expect, it } from 'vitest';
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

  it('does not fold long non-sensitive values across lines (lineWidth: -1)', () => {
    // js-yaml's dumper folds plain scalars into a `>-` block at 80 columns
    // by default, breaking at word boundaries — a folded value here would
    // corrupt M2b's baseHash-matched round-trip substitution. The value
    // must contain spaces: a single unbroken run of characters has no fold
    // point and passes even with folding enabled, silently defeating this
    // regression check. This test fails if `lineWidth: -1` is ever dropped.
    const longValue = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const r = maskYamlSecrets(`proxies:\n  - name: a\n    path: ${JSON.stringify(longValue)}\n`);
    expect(r.parseError).toBe(false);
    expect(r.maskedContent).toContain(longValue);
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
});
