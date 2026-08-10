/**
 * M2b Task 10 — client-side CST patch: builds the WOULD-BE-SUBMITTED YAML
 * text from the server's `maskedContent` plus only the user's dirty
 * (categoryId, fieldKey) edits.
 *
 * BINDING (M2a→M2b handoff, "Task 8: 强约束→Task 10"): the SUBMITTED
 * content must NOT be `yaml.stringify(form.document)` — that would dump the
 * ENTIRE working document, destroying comments, expanding anchors/aliases,
 * and normalizing key order for every field the user never touched, not
 * just the ones they edited. Instead: `parseDocument(maskedContent)` (this
 * file, eemeli `yaml`'s CST) → patch ONLY the dirty leaf paths via
 * `doc.setIn`/`doc.deleteIn` → `Document.toString()`. Comments, anchors, and
 * key order for every UNTOUCHED path survive by construction, because they
 * are simply never visited — the exact same discipline
 * `apps/collector/src/modules/config-editor/apply-pipeline.ts` (Task 5)
 * already applies server-side to the sentinel-resubstitution step, applied
 * here on the client to the user's own edits.
 *
 * Pure and framework-free by design (no React, no `"use client"`, no `@/`
 * path aliases — only the `yaml` package) specifically so it can be
 * exercised directly by a bare `node`/`tsx` script, independent of the
 * React tree, for the comment-survival proof this task's gate requires (see
 * task-10-report.md).
 *
 * Contract per `DirtyEntry` (shape mirrors, and is satisfied by,
 * `UseConfigFormResult.getDirtyEntries()` in use-config-form.ts — that
 * richer type is structurally assignable here, no adapter needed):
 * - `value === undefined` means "the user cleared this field" — patched via
 *   `doc.deleteIn(path)`, guarded by `doc.hasIn(path)` first. Verified
 *   empirically (see task-10-report.md): `deleteIn` THROWS ("Expected YAML
 *   collection at <k>. Remaining path: <rest>") when an intermediate path
 *   segment doesn't exist at all — `hasIn` never throws for a missing path
 *   (returns `false`), so it's the safe guard; deleting an already-absent
 *   path is correctly a no-op (nothing to remove).
 * - Any other value is patched via `doc.setIn(path, value)`. Verified
 *   empirically: `setIn` auto-vivifies missing intermediate maps (e.g.
 *   `setIn(['tun','enable'], true)` on a document with no `tun:` key at all
 *   produces a fresh `tun:` map — no separate "ensure parent exists" step
 *   needed). For a table category's whole-array dirty entry (`path.length
 *   === 1`, e.g. `['proxies']` — table categories are dirty at whole-array
 *   granularity, never per-row; see config-table-editor.tsx), `value` is
 *   the ENTIRE JS array: `setIn` builds a brand-new YAML sequence node from
 *   it, which means any COMMENT that lived INSIDE that array's old text
 *   (e.g. a trailing `# note` on one proxy's password line) does NOT
 *   survive (verified empirically) — this is the accepted, documented
 *   consequence of whole-array dirty granularity (the plan's own binding
 *   choice for table categories), not a splicing bug. A comment OUTSIDE the
 *   touched array — on an untouched flat-category field, or on a different
 *   table category entirely — is unaffected, since that subtree is never
 *   visited.
 * - `setIn` replacing an EXISTING scalar node mutates that node's `.value`
 *   in place rather than swapping in a new node object — verified
 *   empirically: an anchored `key: &a foo` patched via `setIn(['key'],
 *   'bar')` produces `key: &a bar`, and every alias site (`other: *a`)
 *   resolves to the new value with no error. So patching an anchor's own
 *   field is always safe. Deleting a field that HOLDS an anchor referenced
 *   elsewhere is NOT safe — verified empirically: `deleteIn` on such a path
 *   makes `toString()` throw `Error: Unresolved alias (the anchor must be
 *   set before the alias): <name>`. This is a rare but real edge case (the
 *   user clears — not edits — a masked field that happens to be anchored
 *   and aliased elsewhere in their OWN config), so `buildSubmittedText` can
 *   throw, and every caller MUST catch it and show a friendly, localized
 *   error instead of letting it crash the editor tab (see apply-dialog.tsx).
 */
import { parseDocument } from "yaml";

export interface DirtyEntry {
  path: string[];
  value: unknown;
}

export function buildSubmittedText(maskedContent: string, entries: DirtyEntry[]): string {
  const doc = parseDocument(maskedContent);
  for (const entry of entries) {
    if (entry.value === undefined) {
      if (doc.hasIn(entry.path)) {
        doc.deleteIn(entry.path);
      }
      continue;
    }
    doc.setIn(entry.path, entry.value);
  }
  return doc.toString();
}
