"use client";

/**
 * M2b Task 9 — row-table editors for the 3 `isTable` categories
 * (proxies/proxy-groups/rules). Reuses `FieldRenderer` (Task 8) per-row for
 * the two object-shaped categories (proxies/proxy-groups), so protocol/type
 * field sets — including nested fields and the sentinel masked-control —
 * work unchanged. `rules` is not object-shaped (Mihomo stores each rule as
 * a single `"TYPE,PAYLOAD,POLICY"` string), so it gets its own three-segment
 * dialog instead of going through `FieldRenderer`.
 *
 * Document write-back (binding, task-9-brief.md): every table category's
 * array lives at the document root under a key equal to the category id
 * (`proxies`/`proxy-groups`/`rules` — verified against config-metadata.json
 * and Mihomo's own schema). That means `useConfigForm`'s existing
 * `setFieldValue(categoryId, fieldKey, value)` already does exactly what's
 * needed when called as `setFieldValue(categoryId, categoryId, newArray)` —
 * `fieldKey` splits to a single path segment equal to the document-root key.
 * No changes to use-config-form.ts were needed. Editing row N replaces
 * exactly that array element via `.map`; add appends; delete filters; move
 * swaps two elements — every operation is built via structural sharing
 * (elements that weren't touched keep their original object reference),
 * which is what makes 保真 (unrelated rows/keys survive untouched) true at
 * the row-array level, mirroring how `setAtPath` makes it true at the
 * document-key level in use-config-form.ts.
 *
 * Row identity and sentinel resubstitution (fixed, not just documented —
 * see `apps/collector/src/modules/config-editor/apply-pipeline.ts`'s
 * "identity-aware array resolution" amendment): `moveRow`/`removeRow`
 * below (every table category's up/down buttons and delete) change which
 * row sits at which array index. An earlier version of this file flagged
 * that as a hazard, because `apply-pipeline.ts`'s sentinel resubstitution
 * originally paired a submitted array element with the base document's
 * element AT THE SAME INDEX — so reordering or deleting a row that still
 * carried a masked field (e.g. a proxy's `password: __ORBIT_MASKED__`)
 * could resubstitute a DIFFERENT row's secret into it. That has since been
 * fixed at the source: `apply-pipeline.ts` now resolves a masked sentinel's
 * base counterpart BY the row's `name` (the Mihomo convention every
 * `proxies`/`proxy-groups` entry already has), not by array position, and
 * fails closed (`MASK_PATH_MISSING`) rather than guessing whenever a name
 * doesn't match anything in the base document (a rename) or matches more
 * than one row on either side (a duplicate name). Practical contract for
 * THIS component: reordering/deleting rows is safe for `proxies`/
 * `proxy-groups` as long as an edited row's own `name` field isn't changed
 * in the SAME edit that also leaves one of its other fields masked
 * (renaming a row that still has an unrevealed secret makes that secret
 * unresolvable on apply — a safe failure, not silent corruption, and the
 * user can just re-enter/reveal the value). `rules` has no per-row
 * identity (Mihomo rules are plain strings, not named mappings), so its
 * array always resolves positionally in apply-pipeline.ts — unaffected by
 * this fix either way, since rule strings are never sentinel-masked in
 * practice (masking is keyed to option names like `password`, not to
 * arbitrary string array elements).
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, ArrowUp, ArrowDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { FieldRenderer, MASKED_SENTINEL } from "./field-renderer";
import type { UseConfigFormResult } from "./use-config-form";
import type {
  FieldDescriptor,
  RuleTypeDescriptor,
  TableCategory,
} from "@/lib/types/config-metadata";

type Translator = (key: string, values?: Record<string, string | number>) => string;

interface FieldSetLookup {
  type: string;
  label: string;
  fields: FieldDescriptor[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function displayValue(value: unknown): string {
  if (value === MASKED_SENTINEL) return "••••••••";
  if (value === undefined || value === null || value === "") return "—";
  return String(value);
}

function collectNames(document: Record<string, unknown>, key: string): string[] {
  const arr = document[key];
  if (!Array.isArray(arr)) return [];
  const names: string[] = [];
  for (const entry of arr) {
    if (isPlainRecord(entry) && typeof entry.name === "string" && entry.name !== MASKED_SENTINEL) {
      names.push(entry.name);
    }
  }
  return names;
}

/**
 * categoryId doubles as the document-root array key (see file header) —
 * `useConfigForm`'s dirty tracking is also keyed by (categoryId, fieldKey),
 * so using categoryId for both plugs straight into the existing dirty-set
 * machinery at whole-array granularity (one dot for "this table changed",
 * matching Task 8's precedent of parent-field-granularity dirty tracking
 * for nested/compound values).
 */
function useRowArray<T>(form: UseConfigFormResult, categoryId: string) {
  const raw = form.document[categoryId];
  const rows: T[] = Array.isArray(raw) ? (raw as T[]) : [];
  const dirty = form.isFieldDirty(categoryId, categoryId);
  const commit = (next: T[]) => form.setFieldValue(categoryId, categoryId, next);

  return {
    rows,
    dirty,
    addRow: (row: T) => commit([...rows, row]),
    replaceRow: (index: number, row: T) => commit(rows.map((r, i) => (i === index ? row : r))),
    removeRow: (index: number) => commit(rows.filter((_, i) => i !== index)),
    // See the ⚠️ HAZARD block in this file's header comment.
    moveRow: (index: number, direction: -1 | 1) => {
      const target = index + direction;
      if (target < 0 || target >= rows.length) return;
      const next = [...rows];
      [next[index], next[target]] = [next[target], next[index]];
      commit(next);
    },
  };
}

function TableToolbar({
  t,
  label,
  dirty,
  onAdd,
}: {
  t: Translator;
  label: string;
  dirty: boolean;
  onAdd: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <div className="flex items-center gap-1.5">
        <span className="text-sm font-medium">{label}</span>
        {dirty && (
          <span
            className="w-1.5 h-1.5 rounded-full bg-primary shrink-0"
            role="img"
            aria-label={t("field.changed")}
            title={t("field.changed")}
          />
        )}
      </div>
      <Button size="sm" onClick={onAdd} className="gap-1.5">
        <Plus className="w-3.5 h-3.5" />
        {t("table.add")}
      </Button>
    </div>
  );
}

function RowActions({
  t,
  onEdit,
  onDelete,
  onMoveUp,
  onMoveDown,
  moveUpDisabled,
  moveDownDisabled,
  editDisabled,
  editDisabledTitle,
}: {
  t: Translator;
  onEdit: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  moveUpDisabled: boolean;
  moveDownDisabled: boolean;
  editDisabled?: boolean;
  editDisabledTitle?: string;
}) {
  return (
    <div className="flex items-center justify-end gap-0.5">
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onMoveUp}
        disabled={moveUpDisabled}
        aria-label={t("table.moveUp")}
        title={t("table.moveUp")}>
        <ArrowUp className="w-3.5 h-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onMoveDown}
        disabled={moveDownDisabled}
        aria-label={t("table.moveDown")}
        title={t("table.moveDown")}>
        <ArrowDown className="w-3.5 h-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onEdit}
        disabled={editDisabled}
        aria-label={t("table.edit")}
        title={editDisabled ? editDisabledTitle : t("table.edit")}>
        <Pencil className="w-3.5 h-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onDelete}
        aria-label={t("table.delete")}
        title={t("table.delete")}
        className="text-destructive hover:text-destructive">
        <Trash2 className="w-3.5 h-3.5" />
      </Button>
    </div>
  );
}

function DeleteRowDialog({
  t,
  open,
  name,
  onOpenChange,
  onConfirm,
}: {
  t: Translator;
  open: boolean;
  name: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("table.confirmDeleteTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("table.confirmDeleteDescription", { name })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("table.cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{t("table.delete")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Default values for a freshly-selected protocol/type field set — mirrors
 *  clash-cfg-edit's `onProtocolChange`/`onTypeChange` reference behavior:
 *  `name` is deliberately skipped here (callers preserve it across a type
 *  switch themselves) and only `default`/empty-array pre-fills happen. */
function buildDefaultRow(fieldSet: FieldSetLookup): Record<string, unknown> {
  const row: Record<string, unknown> = { type: fieldSet.type };
  for (const field of fieldSet.fields) {
    if (field.key === "name") continue;
    if (field.default !== undefined) row[field.key] = field.default;
    else if (field.type === "array") row[field.key] = [];
  }
  return row;
}

/** Member-picker for proxy-groups' `proxies` field: sources ADD candidates
 *  from the current document's proxies list, but the selected chips render
 *  from the draft row's OWN array — never filtered against `available` —
 *  so a member naming a proxy-group, a provider-sourced name, or a proxy
 *  that was since renamed/removed still round-trips untouched instead of
 *  being silently dropped on save. */
function ProxyMemberPicker({
  t,
  field,
  value,
  available,
  onChange,
}: {
  t: Translator;
  field: FieldDescriptor;
  value: unknown;
  available: string[];
  onChange: (value: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const selected = Array.isArray(value) ? value.map(String) : [];
  const selectedSet = new Set(selected);
  const candidates = available.filter(
    (name) => !selectedSet.has(name) && (!search || name.toLowerCase().includes(search.toLowerCase())),
  );

  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-center gap-1.5 mb-2">
        <span className="text-sm font-medium">{field.label}</span>
        <span className="text-xs text-muted-foreground">
          {t("table.memberPicker.selectedCount", { count: selected.length })}
        </span>
      </div>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {/* index-based key/removal (not the name itself): a hand-written
           *  config can legitimately list the same member name twice —
           *  keying/filtering by name would collide (React duplicate-key
           *  warning) and remove every copy on one click instead of just
           *  the clicked chip. */}
          {selected.map((name, i) => (
            <Badge key={i} variant="secondary" className="gap-1 pr-1">
              <span className="max-w-40 truncate">{displayValue(name)}</span>
              <button
                type="button"
                onClick={() => onChange(selected.filter((_, idx) => idx !== i))}
                className="rounded-full hover:bg-background/60 p-0.5"
                aria-label={t("table.memberPicker.remove", { name })}>
                <X className="w-3 h-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <Input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t("table.memberPicker.searchPlaceholder")}
        className="mb-2"
      />
      <div className="max-h-40 overflow-y-auto rounded-md border divide-y divide-border/60">
        {available.length === 0 ? (
          <p className="text-xs text-muted-foreground p-3">{t("table.memberPicker.empty")}</p>
        ) : candidates.length === 0 ? (
          <p className="text-xs text-muted-foreground p-3">{t("table.memberPicker.noMatches")}</p>
        ) : (
          candidates.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => onChange([...selected, name])}
              className="w-full text-left px-3 py-1.5 text-sm hover:bg-accent">
              {name}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

/** Free-text input with a filtered suggestion dropdown — for fields whose
 *  value NAMES another entity (a proxy or proxy-group) but is never
 *  constrained to match one. `dialer-proxy`'s mihomo semantics ("value = the
 *  name of an existing outbound/policy-group") mean the true set of valid
 *  values is whatever this draft's proxies/proxy-groups currently contain,
 *  but a provider-sourced name (never listed in this draft at all — see
 *  `ProxyMemberPicker`'s own header comment for the same fidelity point)
 *  is equally valid input. Unlike `ProxyMemberPicker`'s closed chip set,
 *  `options` here only drives the suggestion list — ANY typed text commits
 *  as-is, same "empty text = unset" free-text semantics `FieldControl`'s
 *  plain string branch already applies to this field type.
 *
 *  Anchored (not triggered): a Radix `PopoverTrigger` toggles open/closed on
 *  every click, which would close the just-opened dropdown the instant the
 *  user clicks INTO the already-focused input — `PopoverAnchor` positions
 *  Content without wiring that toggle, so open/close stays fully driven by
 *  this component's own `open` state (focus/typing opens it; a selection,
 *  outside click, or Escape closes it). `onOpenAutoFocus` is suppressed so
 *  opening the dropdown never steals focus away from the input mid-type. */
function NameSuggestInput({
  t,
  value,
  options,
  ariaLabel,
  onChange,
}: {
  t: Translator;
  value: unknown;
  options: string[];
  ariaLabel?: string;
  onChange: (value: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const text = typeof value === "string" ? value : "";
  const query = text.trim().toLowerCase();
  const candidates = query ? options.filter((name) => name.toLowerCase().includes(query)) : options;

  // Mirrors FieldControl's plain string branch exactly (field-renderer.tsx)
  // so a free-typed value round-trips through the same unset-on-empty rule
  // every other string field already follows.
  const commit = (next: string) => onChange(next === "" ? undefined : next);

  const openIfHasOptions = () => {
    if (options.length > 0) setOpen(true);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <Input
          type="text"
          value={text}
          aria-label={ariaLabel}
          onFocus={openIfHasOptions}
          onChange={(e) => {
            commit(e.target.value);
            setHighlighted(0);
            openIfHasOptions();
          }}
          onKeyDown={(e) => {
            if (!open) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlighted((h) => Math.min(h + 1, candidates.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlighted((h) => Math.max(h - 1, 0));
            } else if (e.key === "Enter") {
              const target = candidates[highlighted];
              if (target !== undefined) {
                e.preventDefault();
                commit(target);
                setOpen(false);
              }
            } else if (e.key === "Escape") {
              // Close the dropdown. The enclosing Radix Dialog does NOT
              // close on this same keypress, but not because of the calls
              // below: Radix's escape handling runs on a capture-phase
              // document listener, before React's bubble-phase handler ever
              // fires, so stopPropagation here can't reach it. What actually
              // protects the Dialog is Radix's DismissableLayer stack — only
              // the topmost layer (the open Popover) consumes the Escape.
              // preventDefault/stopPropagation are kept for non-Radix
              // listeners and to keep the input's own behavior inert.
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            }
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={4}
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="w-[var(--radix-popover-trigger-width)] max-h-52 overflow-y-auto p-1"
      >
        {candidates.length === 0 ? (
          <p className="text-xs text-muted-foreground px-2 py-1.5">{t("table.nameSuggest.noMatches")}</p>
        ) : (
          candidates.map((name, index) => (
            <button
              key={name}
              type="button"
              // Keeps focus on the Input across the click (a plain onClick
              // alone would blur it first, closing the dropdown before this
              // handler even runs).
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                commit(name);
                setOpen(false);
              }}
              className={cn(
                "w-full text-left px-2 py-1.5 text-sm rounded-sm hover:bg-accent",
                index === highlighted && "bg-accent",
              )}>
              {name}
            </button>
          ))
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Row shell for `dialer-proxy` fields — matches the label/control layout
 *  every sibling `FieldRenderer` row uses (`table.rows.map` in
 *  `ObjectRowEditDialog` below renders this instead of `FieldRenderer` for
 *  these fields, same bypass `ProxyMemberPicker` already gets for the
 *  `proxies` field — `FieldRenderer` doesn't receive the form/document, so
 *  dynamic name options can't be resolved inside it). */
function DialerProxyField({
  t,
  field,
  value,
  options,
  onChange,
}: {
  t: Translator;
  field: FieldDescriptor;
  value: unknown;
  options: string[];
  onChange: (value: string | undefined) => void;
}) {
  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <span className="text-sm font-medium">{field.label}</span>
        </div>
        <div className="w-full sm:w-72 shrink-0">
          <NameSuggestInput t={t} value={value} options={options} ariaLabel={field.label} onChange={onChange} />
        </div>
      </div>
    </div>
  );
}

/** Shared add/edit dialog for the two object-shaped table categories
 *  (proxies/proxy-groups). `draftRow` is seeded as a full clone of the row
 *  being edited (not rebuilt from the field set) so any key the field set
 *  doesn't describe — a hand-written option config-metadata.json doesn't
 *  know about — survives the edit untouched; only `FieldRenderer`'s
 *  `onChange` for a specific `field.key` ever touches a key of the draft, so
 *  every other key on the row is structurally never read or dropped, same
 *  discipline as `setAtPath` in use-config-form.ts. The type/protocol
 *  selector is locked while editing (matches the clash-cfg-edit reference
 *  this task is scoped from) — switching a saved row's protocol mid-edit
 *  would otherwise silently orphan every field the old protocol declared
 *  that the new one doesn't. */
function ObjectRowEditDialog({
  t,
  open,
  onOpenChange,
  categoryId,
  categoryLabel,
  fieldSets,
  initialRow,
  rowIndex,
  memberPickerFieldKey,
  memberPickerAvailable,
  extraMemberOptions,
  dialerProxyOptions,
  backendId,
  revealDisabled,
  onSave,
}: {
  t: Translator;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categoryId: string;
  categoryLabel: string;
  fieldSets: FieldSetLookup[];
  initialRow: Record<string, unknown> | null;
  rowIndex: number | null;
  memberPickerFieldKey?: string;
  memberPickerAvailable: string[];
  /** Proxy-group names to append to `memberPickerAvailable` (nested group
   *  membership is legal in mihomo) — the row currently being edited is
   *  excluded live, by `draftRow.name`, below. Only meaningful alongside
   *  `memberPickerFieldKey`; omitted entirely by `ProxiesTable` (proxies
   *  have no member picker). */
  extraMemberOptions?: string[];
  /** Suggestion source for every `dialer-proxy` field in this field set —
   *  draft proxies' + proxy-groups' names combined. The row being edited is
   *  excluded live, by `draftRow.name`, below (a proxy can't dialer-proxy
   *  itself). Omitted by `ProxyGroupsTable` (no group type declares a
   *  `dialer-proxy` field). */
  dialerProxyOptions?: string[];
  backendId: number | undefined;
  /** M2b Task 11 — true when this category's whole array is dirty (any
   *  add/remove/move/replace since the last save), which drifts every
   *  row's `path` index out of sync with the server's `maskedPaths` — see
   *  field-renderer.tsx's `FieldRendererProps.revealDisabled` doc comment
   *  for the full hazard this guards against. */
  revealDisabled: boolean;
  onSave: (row: Record<string, unknown>) => void;
}) {
  const isEdit = initialRow !== null;

  const [draftRow, setDraftRow] = useState<Record<string, unknown>>(() =>
    initialRow ? structuredClone(initialRow) : buildDefaultRow(fieldSets[0]),
  );

  const activeFieldSet = fieldSets.find((fs) => fs.type === draftRow.type) ?? fieldSets[0];
  const rowPath = `${categoryId}[${rowIndex ?? "new"}]`;
  // Live (tracks in-progress renames, not just the row as it was when the
  // dialog opened) — used to strip this row's own name out of any
  // name-suggestion source below, so a row never suggests referencing
  // itself.
  const selfName = typeof draftRow.name === "string" ? draftRow.name : undefined;

  const handleTypeChange = (newType: string) => {
    const fieldSet = fieldSets.find((fs) => fs.type === newType);
    if (!fieldSet) return;
    setDraftRow((prev) => {
      const next = buildDefaultRow(fieldSet);
      if (typeof prev.name === "string") next.name = prev.name;
      return next;
    });
  };

  const setFieldDraft = (key: string, value: unknown) =>
    setDraftRow((prev) => ({ ...prev, [key]: value }));

  const resetFieldDraft = (key: string) =>
    setDraftRow((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });

  const handleSave = () => {
    for (const field of activeFieldSet.fields) {
      if (!field.required) continue;
      const value = draftRow[field.key];
      const empty = value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
      if (empty) {
        toast.error(t("table.requiredFieldError", { field: field.label }));
        return;
      }
    }
    onSave(draftRow);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t("table.editTitle", { category: categoryLabel })
              : t("table.addTitle", { category: categoryLabel })}
          </DialogTitle>
        </DialogHeader>

        <div className="divide-y divide-border/60">
          <div className="py-3 first:pt-0">
            <span className="text-sm font-medium block mb-1.5">{t("table.typeLabel")}</span>
            <Select value={draftRow.type as string} onValueChange={handleTypeChange} disabled={isEdit}>
              <SelectTrigger className="w-full" aria-label={t("table.typeLabel")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {fieldSets.map((fs) => (
                  <SelectItem key={fs.type} value={fs.type}>
                    {fs.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {activeFieldSet.fields.map((field) =>
            memberPickerFieldKey && field.key === memberPickerFieldKey ? (
              <ProxyMemberPicker
                key={field.key}
                t={t}
                field={field}
                value={draftRow[field.key]}
                available={Array.from(
                  new Set([
                    ...memberPickerAvailable,
                    ...(extraMemberOptions ?? []).filter((name) => name !== selfName),
                  ]),
                )}
                onChange={(v) => setFieldDraft(field.key, v)}
              />
            ) : field.type === "dialer-proxy" ? (
              <DialerProxyField
                key={field.key}
                t={t}
                field={field}
                value={draftRow[field.key]}
                options={(dialerProxyOptions ?? []).filter((name) => name !== selfName)}
                onChange={(v) => setFieldDraft(field.key, v)}
              />
            ) : (
              <FieldRenderer
                key={field.key}
                field={field}
                value={draftRow[field.key]}
                path={`${rowPath}.${field.key}`}
                siblingValues={draftRow}
                dirty={false}
                backendId={backendId}
                revealDisabled={revealDisabled}
                onChange={(v) => setFieldDraft(field.key, v)}
                onReset={() => resetFieldDraft(field.key)}
              />
            ),
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("table.cancel")}
          </Button>
          <Button onClick={handleSave}>{t("table.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type EditingState = { index: number | null } | null;

function ProxiesTable({
  category,
  form,
  backendId,
}: {
  category: TableCategory;
  form: UseConfigFormResult;
  backendId: number | undefined;
}) {
  const t = useTranslations("configEditor") as unknown as Translator;
  const protocols = category.protocols ?? [];
  const { rows, dirty, addRow, replaceRow, removeRow, moveRow } = useRowArray<Record<string, unknown>>(
    form,
    "proxies",
  );
  const [editing, setEditing] = useState<EditingState>(null);
  const [deleteIndex, setDeleteIndex] = useState<number | null>(null);
  const categoryLabel = t(`categories.${category.id}`);
  // `dialer-proxy`'s mihomo semantics: value = the name of an existing
  // outbound proxy OR policy group — proxies before groups, per the plan.
  const dialerProxyOptions = Array.from(
    new Set([...collectNames(form.document, "proxies"), ...collectNames(form.document, "proxy-groups")]),
  );

  return (
    <Card>
      <CardContent className="p-5 space-y-4">
        <TableToolbar t={t} label={categoryLabel} dirty={dirty} onAdd={() => setEditing({ index: null })} />
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("table.columns.name")}</TableHead>
                <TableHead>{t("table.columns.type")}</TableHead>
                <TableHead>{t("table.columns.server")}</TableHead>
                <TableHead className="text-right">{t("table.columns.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                    {t("table.empty", { category: categoryLabel })}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row, index) => {
                  const fieldSet = protocols.find((p) => p.type === row.type);
                  return (
                    <TableRow key={index}>
                      <TableCell className="font-medium">{displayValue(row.name)}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{fieldSet?.label ?? displayValue(row.type)}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {displayValue(row.server)}
                        {row.port !== undefined && row.server !== MASKED_SENTINEL
                          ? `:${displayValue(row.port)}`
                          : ""}
                      </TableCell>
                      <TableCell className="text-right">
                        <RowActions
                          t={t}
                          editDisabled={!fieldSet}
                          editDisabledTitle={t("table.unsupportedType")}
                          onEdit={() => setEditing({ index })}
                          onDelete={() => setDeleteIndex(index)}
                          onMoveUp={() => moveRow(index, -1)}
                          onMoveDown={() => moveRow(index, 1)}
                          moveUpDisabled={index === 0}
                          moveDownDisabled={index === rows.length - 1}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>

      {editing && (
        <ObjectRowEditDialog
          key={editing.index ?? "add"}
          t={t}
          open
          onOpenChange={(open) => !open && setEditing(null)}
          categoryId="proxies"
          categoryLabel={categoryLabel}
          fieldSets={protocols}
          initialRow={editing.index !== null ? rows[editing.index] : null}
          rowIndex={editing.index}
          memberPickerAvailable={[]}
          dialerProxyOptions={dialerProxyOptions}
          backendId={backendId}
          revealDisabled={dirty}
          onSave={(row) => {
            if (editing.index !== null) replaceRow(editing.index, row);
            else addRow(row);
            setEditing(null);
          }}
        />
      )}

      <DeleteRowDialog
        t={t}
        open={deleteIndex !== null}
        name={deleteIndex !== null ? displayValue(rows[deleteIndex]?.name) : ""}
        onOpenChange={(open) => !open && setDeleteIndex(null)}
        onConfirm={() => {
          if (deleteIndex !== null) removeRow(deleteIndex);
          setDeleteIndex(null);
        }}
      />
    </Card>
  );
}

function ProxyGroupsTable({
  category,
  form,
  backendId,
}: {
  category: TableCategory;
  form: UseConfigFormResult;
  backendId: number | undefined;
}) {
  const t = useTranslations("configEditor") as unknown as Translator;
  const types = category.types ?? [];
  const { rows, dirty, addRow, replaceRow, removeRow, moveRow } = useRowArray<Record<string, unknown>>(
    form,
    "proxy-groups",
  );
  const [editing, setEditing] = useState<EditingState>(null);
  const [deleteIndex, setDeleteIndex] = useState<number | null>(null);
  const categoryLabel = t(`categories.${category.id}`);
  const proxyNames = collectNames(form.document, "proxies");
  // Nested group membership is legal in mihomo — a group's member list can
  // itself name another proxy-group. Self-exclusion (the group currently
  // being edited can't list itself) happens live, by `draftRow.name`, inside
  // `ObjectRowEditDialog` — this raw list is passed through unfiltered.
  const proxyGroupNames = collectNames(form.document, "proxy-groups");

  return (
    <Card>
      <CardContent className="p-5 space-y-4">
        <TableToolbar t={t} label={categoryLabel} dirty={dirty} onAdd={() => setEditing({ index: null })} />
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("table.columns.name")}</TableHead>
                <TableHead>{t("table.columns.type")}</TableHead>
                <TableHead>{t("table.columns.members")}</TableHead>
                <TableHead className="text-right">{t("table.columns.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                    {t("table.empty", { category: categoryLabel })}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row, index) => {
                  const fieldSet = types.find((ty) => ty.type === row.type);
                  const members = Array.isArray(row.proxies) ? (row.proxies as unknown[]) : [];
                  return (
                    <TableRow key={index}>
                      <TableCell className="font-medium">{displayValue(row.name)}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{fieldSet?.label ?? displayValue(row.type)}</Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1 max-w-xs">
                          {members.length === 0 ? (
                            <span className="text-muted-foreground text-xs">—</span>
                          ) : (
                            <>
                              {members.slice(0, 3).map((m, i) => (
                                <Badge key={i} variant="secondary" className="text-[10px]">
                                  {displayValue(m)}
                                </Badge>
                              ))}
                              {members.length > 3 && (
                                <Badge variant="outline" className="text-[10px]">
                                  +{members.length - 3}
                                </Badge>
                              )}
                            </>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <RowActions
                          t={t}
                          editDisabled={!fieldSet}
                          editDisabledTitle={t("table.unsupportedType")}
                          onEdit={() => setEditing({ index })}
                          onDelete={() => setDeleteIndex(index)}
                          onMoveUp={() => moveRow(index, -1)}
                          onMoveDown={() => moveRow(index, 1)}
                          moveUpDisabled={index === 0}
                          moveDownDisabled={index === rows.length - 1}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>

      {editing && (
        <ObjectRowEditDialog
          key={editing.index ?? "add"}
          t={t}
          open
          onOpenChange={(open) => !open && setEditing(null)}
          categoryId="proxy-groups"
          categoryLabel={categoryLabel}
          fieldSets={types}
          initialRow={editing.index !== null ? rows[editing.index] : null}
          rowIndex={editing.index}
          memberPickerFieldKey="proxies"
          memberPickerAvailable={proxyNames}
          extraMemberOptions={proxyGroupNames}
          backendId={backendId}
          revealDisabled={dirty}
          onSave={(row) => {
            if (editing.index !== null) replaceRow(editing.index, row);
            else addRow(row);
            setEditing(null);
          }}
        />
      )}

      <DeleteRowDialog
        t={t}
        open={deleteIndex !== null}
        name={deleteIndex !== null ? displayValue(rows[deleteIndex]?.name) : ""}
        onOpenChange={(open) => !open && setDeleteIndex(null)}
        onConfirm={() => {
          if (deleteIndex !== null) removeRow(deleteIndex);
          setDeleteIndex(null);
        }}
      />
    </Card>
  );
}

interface ParsedRule {
  masked: boolean;
  type: string;
  payload: string;
  policy: string;
  hasValue: boolean;
  /** Any segments after payload/policy — e.g. `IP-CIDR,10.0.0.0/8,DIRECT,
   *  no-resolve`'s trailing `no-resolve`. Mihomo rule options live here.
   *  Carried through edit-and-save untouched (never surfaced as an editable
   *  field — this task's brief only asks for type/payload/policy), so a
   *  row with a 4th segment keeps it after being edited instead of losing
   *  it — the same "clone the whole thing, only touch what's actually
   *  edited" 保真 discipline `ObjectRowEditDialog` applies to object rows,
   *  applied here to rules' string shape. */
  extra: string[];
}

/** Mihomo rule format: `"TYPE,PAYLOAD,POLICY[,OPTION...]"`, or
 *  `"TYPE,POLICY[,OPTION...]"` for a rule type with no payload segment
 *  (MATCH). Mirrors clash-cfg-edit's `RuleTable.vue` `parseRule`/
 *  `formatRule` reference for the type/payload/policy split (falls back to
 *  a payload-bearing read when the type isn't recognized), but — unlike
 *  that reference — keeps everything past the policy segment instead of
 *  silently discarding it on save. A raw string exactly equal to the
 *  masking sentinel (possible: yaml-mask.ts's value-equality pass masks
 *  ANY string in the document that matches a previously-collected secret
 *  verbatim, including a whole rule string, however rare in practice) is
 *  surfaced as `masked` rather than parsed — same "replace wholesale,
 *  never in place" rule FieldRenderer's masked-field control already
 *  follows for object fields. */
function parseRuleRow(raw: string, ruleTypes: RuleTypeDescriptor[]): ParsedRule {
  if (raw === MASKED_SENTINEL) {
    return { masked: true, type: "", payload: "", policy: "", hasValue: true, extra: [] };
  }
  const parts = raw.split(",");
  const type = parts[0] ?? "";
  const descriptor = ruleTypes.find((rt) => rt.type === type);
  const hasValue = descriptor ? descriptor.hasValue : true;
  if (!hasValue) {
    return { masked: false, type, payload: "", policy: parts[1] ?? "", hasValue, extra: parts.slice(2) };
  }
  return { masked: false, type, payload: parts[1] ?? "", policy: parts[2] ?? "", hasValue, extra: parts.slice(3) };
}

function RuleEditDialog({
  t,
  open,
  onOpenChange,
  ruleTypes,
  policyOptions,
  initialRaw,
  onSave,
}: {
  t: Translator;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ruleTypes: RuleTypeDescriptor[];
  policyOptions: string[];
  initialRaw: string | null;
  onSave: (raw: string) => void;
}) {
  const isEdit = initialRaw !== null;
  const parsedInitial = initialRaw !== null ? parseRuleRow(initialRaw, ruleTypes) : null;
  const startFresh = !parsedInitial || parsedInitial.masked;

  const [type, setType] = useState(startFresh ? (ruleTypes[0]?.type ?? "") : parsedInitial!.type);
  const [payload, setPayload] = useState(startFresh ? "" : parsedInitial!.payload);
  const [policy, setPolicy] = useState(startFresh ? (policyOptions[0] ?? "DIRECT") : parsedInitial!.policy);
  // Never edited through this dialog (the brief only asks for a
  // type/payload/policy editor) — carried as-is so a rule with Mihomo
  // options past the policy segment (e.g. `no-resolve`) keeps them on
  // save instead of silently losing them. See ParsedRule's doc comment.
  const extra = startFresh ? [] : parsedInitial!.extra;

  const descriptor = ruleTypes.find((rt) => rt.type === type);
  const hasValue = descriptor ? descriptor.hasValue : true;

  const handleTypeChange = (next: string) => {
    setType(next);
    const nextDescriptor = ruleTypes.find((rt) => rt.type === next);
    if (nextDescriptor && !nextDescriptor.hasValue) setPayload("");
  };

  const handleSave = () => {
    const trimmedPayload = payload.trim();
    if (hasValue && !trimmedPayload) {
      toast.error(t("table.rules.payloadRequired"));
      return;
    }
    if (!policy.trim()) {
      toast.error(t("table.rules.policyRequired"));
      return;
    }
    const segments = hasValue ? [type, trimmedPayload, policy, ...extra] : [type, policy, ...extra];
    onSave(segments.join(","));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t("table.editTitle", { category: t("categories.rules") })
              : t("table.addTitle", { category: t("categories.rules") })}
          </DialogTitle>
          {parsedInitial?.masked && <DialogDescription>{t("table.rules.maskedRow")}</DialogDescription>}
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <span className="text-sm font-medium block mb-1.5">{t("table.rules.typeLabel")}</span>
            <Select value={type} onValueChange={handleTypeChange}>
              <SelectTrigger className="w-full" aria-label={t("table.rules.typeLabel")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ruleTypes.map((rt) => (
                  <SelectItem key={rt.type} value={rt.type}>
                    {rt.label} ({rt.type})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {hasValue ? (
            <div>
              <span className="text-sm font-medium block mb-1.5">{t("table.rules.payloadLabel")}</span>
              <Input value={payload} onChange={(e) => setPayload(e.target.value)} />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{t("table.rules.noPayloadHint")}</p>
          )}

          <div>
            <span className="text-sm font-medium block mb-1.5">{t("table.rules.policyLabel")}</span>
            <Select value={policy} onValueChange={setPolicy}>
              <SelectTrigger className="w-full" aria-label={t("table.rules.policyLabel")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {policyOptions.map((opt) => (
                  <SelectItem key={opt} value={opt}>
                    {opt}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("table.cancel")}
          </Button>
          <Button onClick={handleSave}>{t("table.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RulesTable({ category, form }: { category: TableCategory; form: UseConfigFormResult }) {
  const t = useTranslations("configEditor") as unknown as Translator;
  const ruleTypes = category.ruleTypes ?? [];
  const { rows, dirty, addRow, replaceRow, removeRow, moveRow } = useRowArray<string>(form, "rules");
  const [editing, setEditing] = useState<EditingState>(null);
  const [deleteIndex, setDeleteIndex] = useState<number | null>(null);
  const categoryLabel = t(`categories.${category.id}`);
  // Built-in mihomo policies first, then groups, then individual proxies
  // (a rule can route straight to one node, not just a group) — deduped in
  // case a hand-written config somehow shares a name across the two.
  const policyOptions = Array.from(
    new Set([
      "DIRECT",
      "REJECT",
      "REJECT-DROP",
      "PASS",
      ...collectNames(form.document, "proxy-groups"),
      ...collectNames(form.document, "proxies"),
    ]),
  );

  return (
    <Card>
      <CardContent className="p-5 space-y-4">
        <TableToolbar t={t} label={categoryLabel} dirty={dirty} onAdd={() => setEditing({ index: null })} />
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">{t("table.rules.columnIndex")}</TableHead>
                <TableHead>{t("table.rules.columnType")}</TableHead>
                <TableHead>{t("table.rules.columnPayload")}</TableHead>
                <TableHead>{t("table.rules.columnPolicy")}</TableHead>
                <TableHead className="text-right">{t("table.columns.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                    {t("table.empty", { category: categoryLabel })}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((raw, index) => {
                  const parsed = parseRuleRow(raw, ruleTypes);
                  const typeLabel = ruleTypes.find((rt) => rt.type === parsed.type)?.label ?? parsed.type;
                  // A rule type outside this metadata's 8 (e.g. a logic
                  // rule like `AND,(...)`, or any Mihomo rule type
                  // config-metadata.json doesn't describe) can't be decoded
                  // into type/payload/policy without risking mangling it on
                  // save — same guard `ObjectRowEditDialog` applies to a
                  // proxy/group row whose `type` isn't in its field-set
                  // list. Masked rows stay editable (that's the recovery
                  // path for a sentinel-masked whole rule string).
                  const editable = parsed.masked || ruleTypes.some((rt) => rt.type === parsed.type);
                  return (
                    <TableRow key={index}>
                      <TableCell className="text-muted-foreground text-xs">{index + 1}</TableCell>
                      {parsed.masked ? (
                        <TableCell colSpan={3} className="text-muted-foreground text-xs">
                          {t("table.rules.maskedRow")}
                        </TableCell>
                      ) : (
                        <>
                          <TableCell>
                            <Badge variant="outline">{typeLabel || "—"}</Badge>
                          </TableCell>
                          <TableCell className="text-muted-foreground max-w-56 truncate">
                            {parsed.hasValue ? displayValue(parsed.payload) : "—"}
                          </TableCell>
                          <TableCell>
                            <Badge variant="secondary">{parsed.policy || "—"}</Badge>
                          </TableCell>
                        </>
                      )}
                      <TableCell className="text-right">
                        <RowActions
                          t={t}
                          editDisabled={!editable}
                          editDisabledTitle={t("table.unsupportedType")}
                          onEdit={() => setEditing({ index })}
                          onDelete={() => setDeleteIndex(index)}
                          onMoveUp={() => moveRow(index, -1)}
                          onMoveDown={() => moveRow(index, 1)}
                          moveUpDisabled={index === 0}
                          moveDownDisabled={index === rows.length - 1}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>

      {editing && (
        <RuleEditDialog
          key={editing.index ?? "add"}
          t={t}
          open
          onOpenChange={(open) => !open && setEditing(null)}
          ruleTypes={ruleTypes}
          policyOptions={policyOptions}
          initialRaw={editing.index !== null ? rows[editing.index] : null}
          onSave={(raw) => {
            if (editing.index !== null) replaceRow(editing.index, raw);
            else addRow(raw);
            setEditing(null);
          }}
        />
      )}

      <DeleteRowDialog
        t={t}
        open={deleteIndex !== null}
        name={deleteIndex !== null ? displayValue(rows[deleteIndex]) : ""}
        onOpenChange={(open) => !open && setDeleteIndex(null)}
        onConfirm={() => {
          if (deleteIndex !== null) removeRow(deleteIndex);
          setDeleteIndex(null);
        }}
      />
    </Card>
  );
}

export function ConfigTableEditor({
  category,
  form,
  backendId,
}: {
  category: TableCategory;
  form: UseConfigFormResult;
  backendId: number | undefined;
}) {
  switch (category.id) {
    case "proxies":
      return <ProxiesTable category={category} form={form} backendId={backendId} />;
    case "proxy-groups":
      return <ProxyGroupsTable category={category} form={form} backendId={backendId} />;
    case "rules":
      // No FieldRenderer usage here — rules are edited via RuleEditDialog's
      // own type/payload/policy inputs (a masked whole-rule string is
      // surfaced as a locked replace-only row, never revealed per-field —
      // see RuleEditDialog's header comment), so no `backendId` needed.
      return <RulesTable category={category} form={form} />;
    default:
      return null;
  }
}
