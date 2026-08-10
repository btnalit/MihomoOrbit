"use client";

/**
 * M2b Task 8 — form state for the metadata-driven config editor.
 *
 * Owns the ONLY parse of `maskedContent` (via `yaml.parse`, eemeli's
 * package) and the single mutable working document derived from it. Every
 * flat-category field's displayed value is read off this document by
 * splitting `FieldDescriptor.key` on `.` (verified against the actual
 * config-metadata.json: flat-category field keys are always the FULL
 * absolute path from the document root — `"port"`, `"tun.enable"`,
 * `"dns.nameserver-policy"` — never relative to their category id).
 *
 * Fidelity principle (binding, task-8-brief.md): writing form edits back
 * only ever overwrites the exact paths the user touched through a rendered
 * field control. Every other key already present in the parsed document —
 * including any Mihomo option config-metadata.json doesn't describe at
 * all — is never read, mutated, or dropped, because `setFieldValue` is the
 * only function that calls `setAtPath`, and it is only ever invoked with a
 * `FieldDescriptor.key` that came from the metadata file itself.
 *
 * `document`/`working` and `dirty` are kept in ONE `useState` object and
 * always replaced together, in the same `setState` call, for two reasons:
 *   1. When `maskedContent` changes identity (a refetch delivers different
 *      server content — e.g. after Task 10's apply flow lands), the old
 *      `dirty` set must NOT survive re-parsing, or it would keep claiming
 *      paths as user-edited when they're actually fresh server values —
 *      Task 10 would then overwrite keys the user never touched.
 *   2. Every `setFieldValue`/`resetField` call needs the document mutation
 *      and the dirty-set update to land in the exact same render pass, so
 *      `values` (derived via `useMemo` keyed on the whole state object)
 *      never observes a document/dirty-set pair that are out of sync.
 */

import { useCallback, useMemo, useState } from "react";
import { parse as parseYaml } from "yaml";
import type { Category, ConfigMetadata, FlatCategory } from "@/lib/types/config-metadata";

export type ConfigFormValue = unknown;

function isFlatCategory(category: Category): category is FlatCategory {
  return !category.isTable;
}

function splitPath(key: string): string[] {
  return key.split(".");
}

// Exported (M2b Task 10 review fix, Finding 2): config-editor-page.tsx's
// conflict-replay logic needs to read a value off a FRESHLY-parsed
// document (the just-refetched base) at an arbitrary path, using the exact
// same traversal semantics `values`/`getDirtyEntries` already use here —
// reusing this rather than re-implementing an equivalent walk elsewhere in
// the same package.
export function getAtPath(root: unknown, path: string[]): unknown {
  let cur = root;
  for (const segment of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur;
}

/** Mutates `root` in place. Setting `undefined` deletes the leaf key
 *  (rather than assigning a literal `undefined`) — none of the 5 flat
 *  categories' fields are `required: true` (verified against the source
 *  JSON), so "the user cleared this field" safely means "drop it from the
 *  config and let Mihomo's own default apply", not "write a null/undefined
 *  YAML value". */
function setAtPath(root: Record<string, unknown>, path: string[], value: unknown): void {
  let cur = root;
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i];
    const next = cur[segment];
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      const created: Record<string, unknown> = {};
      cur[segment] = created;
      cur = created;
    } else {
      cur = next as Record<string, unknown>;
    }
  }
  const lastKey = path[path.length - 1];
  if (value === undefined) {
    delete cur[lastKey];
  } else {
    cur[lastKey] = value;
  }
}

// Exported (M2b Task 10 review fix, Finding 2): config-editor-page.tsx
// needs the SAME parse-with-fallback semantics (empty/comment-only/
// non-object-root YAML -> {}) to turn a freshly-refetched `maskedContent`
// into a comparable value tree for the conflict-replay's per-entry
// staleness check — reusing this rather than duplicating the fallback
// rules elsewhere in the same package.
export function parseDocument(maskedContent: string | undefined): Record<string, unknown> {
  if (!maskedContent) return {};
  let parsed: unknown;
  try {
    parsed = parseYaml(maskedContent);
  } catch {
    // maskedContent comes from the collector's own js-yaml `dump()` output
    // (see yaml-mask.ts) so this should never actually throw — fail safe
    // (empty, editable document) rather than crash the page if it ever does.
    parsed = undefined;
  }
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  // null (empty/comment-only YAML — a VALID empty document, see yaml-mask.ts)
  // or a non-object root (malformed relative to what a Mihomo config should
  // be) both fall back to an empty, still-editable document.
  return {};
}

interface FormState {
  /** Identity of the `maskedContent` this state was parsed from — compared
   *  by value (strings compare by content), so an unrelated refetch that
   *  returns byte-identical content does NOT reset in-progress edits. */
  source: string | undefined;
  /** Immutable snapshot from the initial parse — `resetField` restores
   *  from here. Never mutated after creation. */
  original: Record<string, unknown>;
  /** The live document — mutated in place by `setFieldValue`/`resetField`.
   *  Exposed as `document` for a future consumer (Task 10) to
   *  `yaml.stringify()` into the apply preview. */
  working: Record<string, unknown>;
  /** categoryId -> Set of `FieldDescriptor.key` the user has touched
   *  through a rendered control. */
  dirty: Record<string, Set<string>>;
}

function createFormState(maskedContent: string | undefined): FormState {
  const original = parseDocument(maskedContent);
  return {
    source: maskedContent,
    original,
    working: structuredClone(original),
    dirty: {},
  };
}

/** M2b Task 10 — one dirty (categoryId, fieldKey) enumerated by
 *  `getDirtyEntries()`, with its already-split document `path` and its
 *  CURRENT resolved `value` (read off `working`, i.e. post-edit). Table
 *  categories (proxies/proxy-groups/rules) surface here exactly like a flat
 *  field — `fieldKey === categoryId` and `path` has length 1 (e.g.
 *  `["proxies"]`), `value` the entire replaced array (see
 *  config-table-editor.tsx: table categories are dirty at whole-array
 *  granularity, never per-row) — a consumer doesn't need to special-case
 *  table categories at all, the (path, value) pair is uniform. `value ===
 *  undefined` means the user cleared the field down to nothing — per this
 *  file's own `setAtPath` convention, that means DELETE the key, not write
 *  a literal null; use-submit-content.ts's `buildSubmittedText` is built
 *  against that exact contract.
 *
 *  `baseValue` (M2b Task 10 review fix, Finding 2): the value at this same
 *  `path` in `original` — i.e. what was on disk BEFORE the user touched
 *  this field, captured at the moment this entry is enumerated. This is
 *  NOT the same as `value` (the post-edit working value) — it exists
 *  purely so a conflict-replay can tell whether upstream ALSO changed this
 *  exact path since the user started editing: if a freshly-refetched
 *  base's value at `path` still equals `baseValue`, nobody else touched it
 *  and replaying `value` on top is safe; if it differs, someone else's
 *  change is already sitting there and blindly overwriting it with the
 *  user's stale edit would be a silent merge by another name — the
 *  replay must skip that entry instead (see config-editor-page.tsx's
 *  `handleRefetchAndReplay`). */
export interface DirtyEntry {
  categoryId: string;
  fieldKey: string;
  path: string[];
  value: ConfigFormValue;
  baseValue: ConfigFormValue;
}

export interface UseConfigFormResult {
  /** Live working document — see `FormState.working`. */
  document: Record<string, unknown>;
  /** categoryId -> fieldKey -> current resolved value. */
  values: Record<string, Record<string, ConfigFormValue>>;
  hasAnyDirty: boolean;
  isFieldDirty: (categoryId: string, fieldKey: string) => boolean;
  setFieldValue: (categoryId: string, fieldKey: string, value: ConfigFormValue) => void;
  /** Restores a single field to its originally-parsed value and clears its
   *  dirty flag. Used by the masked-field control's "cancel edit" action —
   *  see field-renderer.tsx. */
  resetField: (categoryId: string, fieldKey: string) => void;
  /** Enumerates every dirty (categoryId, fieldKey) — Task 10's submit/replay
   *  contract (see the M2a→M2b handoff's binding constraint on Task 10: the
   *  submitted content is built by patching ONLY these dirty leaf paths onto
   *  a CST-parsed `maskedContent`, never by `yaml.stringify(document)`).
   *  A `useCallback` keyed on the whole `state` object (mirrors
   *  `isFieldDirty`/`values` above) — its IDENTITY changes exactly when
   *  `dirty`/`working` change, which callers rely on as a memo dependency
   *  (see apply-dialog.tsx) instead of re-deriving equality themselves. */
  getDirtyEntries: () => DirtyEntry[];
}

export function useConfigForm(
  metadata: ConfigMetadata | undefined,
  maskedContent: string | undefined,
): UseConfigFormResult {
  const [state, setState] = useState<FormState>(() => createFormState(maskedContent));

  // "Adjusting state when a prop changes" (React's own sanctioned pattern):
  // detected during render, applied via setState during render. React
  // discards this render's output and immediately re-renders with the new
  // state before committing — no flash, no infinite loop, since the guard
  // condition (`state.source !== maskedContent`) is false on the very next
  // pass. This is what keeps `working`/`dirty` reset atomically together —
  // see the file header for why a separate useEffect-based reset would let
  // a stale `dirty` set survive one extra render.
  if (state.source !== maskedContent) {
    setState(createFormState(maskedContent));
  }

  const flatCategories = useMemo(
    () => (metadata?.categories.filter(isFlatCategory) ?? []),
    [metadata],
  );

  const setFieldValue = useCallback(
    (categoryId: string, fieldKey: string, value: ConfigFormValue) => {
      setState((prev) => {
        setAtPath(prev.working, splitPath(fieldKey), value);
        const dirty = { ...prev.dirty };
        const set = new Set(dirty[categoryId] ?? []);
        set.add(fieldKey);
        dirty[categoryId] = set;
        return { ...prev, dirty };
      });
    },
    [],
  );

  const resetField = useCallback((categoryId: string, fieldKey: string) => {
    setState((prev) => {
      if (!prev.dirty[categoryId]?.has(fieldKey)) return prev;
      const originalValue = getAtPath(prev.original, splitPath(fieldKey));
      setAtPath(
        prev.working,
        splitPath(fieldKey),
        originalValue === undefined ? undefined : structuredClone(originalValue),
      );
      const dirty = { ...prev.dirty };
      const set = new Set(dirty[categoryId]);
      set.delete(fieldKey);
      dirty[categoryId] = set;
      return { ...prev, dirty };
    });
  }, []);

  const values = useMemo(() => {
    const result: Record<string, Record<string, ConfigFormValue>> = {};
    for (const category of flatCategories) {
      const bucket: Record<string, ConfigFormValue> = {};
      for (const field of category.fields) {
        bucket[field.key] = getAtPath(state.working, splitPath(field.key));
      }
      result[category.id] = bucket;
    }
    return result;
  }, [flatCategories, state]);

  const isFieldDirty = useCallback(
    (categoryId: string, fieldKey: string) => !!state.dirty[categoryId]?.has(fieldKey),
    [state],
  );

  const hasAnyDirty = useMemo(
    () => Object.values(state.dirty).some((set) => set.size > 0),
    [state],
  );

  const getDirtyEntries = useCallback((): DirtyEntry[] => {
    const entries: DirtyEntry[] = [];
    for (const categoryId of Object.keys(state.dirty)) {
      for (const fieldKey of state.dirty[categoryId]) {
        const path = splitPath(fieldKey);
        entries.push({
          categoryId,
          fieldKey,
          path,
          value: getAtPath(state.working, path),
          baseValue: getAtPath(state.original, path),
        });
      }
    }
    return entries;
  }, [state]);

  return {
    document: state.working,
    values,
    hasAnyDirty,
    isFieldDirty,
    setFieldValue,
    resetField,
    getDirtyEntries,
  };
}
