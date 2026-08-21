"use client";

/**
 * M2b Task 8 — `FieldDescriptor` -> control. Recursive (an `object` field
 * with `nestedFields` renders each nested `FieldDescriptor` through this
 * same component), so it doubles as Task 9's per-row field renderer for the
 * table categories (proxies/proxy-groups protocol/type field sets nest to
 * depth 2, e.g. vmess's `ws-opts.headers.Host`).
 *
 * `field.label`/`description`/`example` are rendered verbatim from
 * config-metadata.json and are Chinese-only in the source file — this is a
 * deliberate, pre-existing decision (project CLAUDE.md: the metadata JSON
 * is "reused directly" / "data-driven, not hardcoded"; supporting a new
 * config option means editing that JSON, not this component), not an
 * oversight. Everything THIS component itself authors (buttons, hints,
 * masked-state chrome) is i18n-keyed under `configEditor.field.*` in both
 * locales — the metadata JSON is data, not part of the message catalog the
 * i18n parity gate checks.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Eye, EyeOff, Loader2, Pencil, RotateCcw, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useRevealValue } from "@/hooks/api/use-config-editor";
import type { FieldDescriptor, FieldMetaValue, FieldShowWhen } from "@/lib/types/config-metadata";

/** Cross-milestone contract — must match apps/collector/src/modules/
 *  config-editor/yaml-mask.ts's `MASK_SENTINEL` exactly (see that file's
 *  header comment: "must never change once agents/collectors in the field
 *  depend on it"). Duplicated here rather than imported: apps/collector and
 *  apps/web are separate deployables with no shared package for this. */
export const MASKED_SENTINEL = "__ORBIT_MASKED__";

/** Radix `Select.Item` rejects an empty-string `value` prop outright — a
 *  few table-category fields (out of Task 8's flat-category scope, e.g.
 *  vmess's `client-fingerprint`) declare `""` as a real, selectable option
 *  meaning "no preference". Mapped to/from this sentinel at the boundary
 *  so the actual stored/emitted value is still the true empty string. */
const EMPTY_OPTION_VALUE = "__configEditor_emptyOption__";

interface FieldRendererProps {
  field: FieldDescriptor;
  value: unknown;
  /** Absolute document path for this field (dot-joined, matching
   *  `ConfigCurrent.maskedPaths` entries) — MUST exactly match yaml-mask.ts's
   *  path-builder format (`key.key`, `key[index]`) since it's sent verbatim
   *  to `POST /reveal`, which 404s (`PATH_NOT_MASKED`) on any mismatch. */
  path: string;
  /** This field's SIBLINGS in the same field-set (the same array
   *  `FieldDescriptor[]` this field itself came from), keyed by their own
   *  `.key` — `showWhen.field` always names a sibling in this exact set,
   *  never a field elsewhere in the document. */
  siblingValues: Record<string, unknown>;
  dirty: boolean;
  onChange: (value: unknown) => void;
  onReset: () => void;
  /** For `useRevealValue(backendId)` inside the masked-field control. */
  backendId: number | undefined;
  /** M2b Task 11 review: an array-table row's own index-based `path`
   *  segment (`proxies[N]`) drifts out of sync with the SERVER's
   *  maskedPaths (computed fresh from the last-saved content, not the
   *  client's in-progress edits) the instant that row's ARRAY is reordered
   *  locally (`config-table-editor.tsx`'s `moveRow`/add/remove — all of
   *  which dirty the whole array, per that file's `useRowArray`). Revealing
   *  through a drifted index would silently return a DIFFERENT row's real
   *  secret, misattributed to the row on screen — not a 404, no visible
   *  signal. Callers pass `true` here whenever the enclosing array is dirty
   *  (`form.isFieldDirty(categoryId, categoryId)`) to fail closed: disables
   *  the reveal button (not the field itself) with an explanatory title,
   *  until the array's edits are applied or discarded and indices are
   *  trustworthy again. Flat-category fields never hit this (their `path`
   *  has no array segment), so `FlatCategoryForm` leaves this at its
   *  default `false`. */
  revealDisabled?: boolean;
}

/** Best-effort coercion of a freshly-revealed value into whatever shape the
 *  target field's edit control expects, used ONLY when seeding "编辑" from a
 *  just-revealed value (see `FieldRenderer` below). yaml-mask.ts masks a
 *  sensitive-keyed value regardless of its actual YAML type (maskByKey masks
 *  unconditionally; only the SEPARATE `secretValues`-collection step is
 *  string+length-gated) — so a revealed value is not guaranteed to already
 *  be a string even for a `type: "string"` field. Without this, several
 *  `FieldControl` branches' own strict `typeof` checks (`typeof value ===
 *  "string" ? value : ""`, etc.) would silently render an EMPTY control
 *  instead of the value the user just saw, which would look exactly like
 *  the reveal having failed. `undefined` means "don't seed, start blank" —
 *  the existing pre-Task-11 behavior — not "seed with an empty value". */
function coerceSeedValue(field: FieldDescriptor, raw: unknown): unknown {
  switch (field.type) {
    case "string":
    case "dialer-proxy":
    case "select":
      if (raw === undefined || raw === null) return undefined;
      return typeof raw === "string" ? raw : String(raw);
    case "number": {
      if (typeof raw === "number") return raw;
      if (typeof raw === "string" && raw.trim() !== "" && !Number.isNaN(Number(raw))) return Number(raw);
      return undefined;
    }
    case "boolean":
      return !!raw;
    case "array":
      return Array.isArray(raw) ? raw : undefined;
    case "object":
      return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : undefined;
    default:
      return raw;
  }
}

function shouldShow(showWhen: FieldShowWhen | undefined, siblingValues: Record<string, unknown>): boolean {
  if (!showWhen) return true;
  return siblingValues[showWhen.field] === showWhen.value;
}

function formatPlaceholder(field: FieldDescriptor): string | undefined {
  const source = field.default ?? field.example;
  if (source === undefined) return undefined;
  if (Array.isArray(source)) return source.join(", ");
  if (typeof source === "object") return JSON.stringify(source);
  return String(source);
}

export function FieldRenderer({
  field,
  value,
  path,
  siblingValues,
  dirty,
  onChange,
  onReset,
  backendId,
  revealDisabled = false,
}: FieldRendererProps) {
  const t = useTranslations("configEditor.field");
  const [maskedEditing, setMaskedEditing] = useState(false);
  // M2b Task 11 — plaintext lives ONLY in this component's own state, never
  // in React Query's cache (`useRevealValue` is a mutation, its result is
  // never stored by the query client) and never in the form document
  // (`onChange` is not called just by revealing). Cleared explicitly on
  // blur (see `handleFieldBlur` below) and on "取消编辑,恢复隐藏"; cleared
  // implicitly on unmount (component teardown) and on a Radix Tabs
  // tab-switch (`TabsContent` unmounts inactive panels by default — no
  // `forceMount` is used anywhere in this feature — so switching tabs is
  // already an unmount, no extra code needed for that case).
  const [revealedValue, setRevealedValue] = useState<{ value: unknown } | null>(null);

  if (!shouldShow(field.showWhen, siblingValues)) return null;

  const isMasked = value === MASKED_SENTINEL && !maskedEditing;

  // Attached to the WHOLE field row (not just one input) so that clicking
  // the "替换此值" button right after a reveal doesn't race its own blur:
  // a plain `onBlur` on the revealed input alone would fire (and clear
  // `revealedValue`) the instant focus leaves it, which happens BEFORE the
  // newly-clicked button's own onClick in the DOM's real event order —
  // defeating "seed the edit control with the revealed value" before it
  // ever runs. Checking `relatedTarget` containment instead only clears
  // when focus leaves the ENTIRE row (a real "moved away from this
  // field"), not when it moves between two controls inside the same row.
  const handleFieldBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setRevealedValue(null);
    }
  };

  return (
    <div className="py-3 first:pt-0 last:pb-0" onBlur={handleFieldBlur}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium">{field.label}</span>
            {dirty && (
              <span
                className="w-1.5 h-1.5 rounded-full bg-primary shrink-0"
                role="img"
                aria-label={t("changed")}
                title={t("changed")}
              />
            )}
          </div>
          {field.description && (
            <p className="text-xs text-muted-foreground mt-0.5">{field.description}</p>
          )}
        </div>
        <div className="w-full sm:w-72 shrink-0">
          {isMasked ? (
            <MaskedFieldControl
              path={path}
              backendId={backendId}
              disabled={revealDisabled}
              revealedValue={revealedValue}
              onRevealed={(v) => setRevealedValue({ value: v })}
              onHide={() => setRevealedValue(null)}
            />
          ) : (
            <>
              <FieldControl
                field={field}
                value={
                  value === MASKED_SENTINEL
                    ? maskedEditing && revealedValue
                      ? coerceSeedValue(field, revealedValue.value)
                      : undefined
                    : value
                }
                path={path}
                backendId={backendId}
                revealDisabled={revealDisabled}
                onChange={onChange}
              />
              {maskedEditing && (
                <button
                  type="button"
                  onClick={() => {
                    setMaskedEditing(false);
                    setRevealedValue(null);
                    onReset();
                  }}
                  className="text-xs text-muted-foreground hover:text-foreground mt-1 inline-flex items-center gap-1"
                >
                  <RotateCcw className="w-3 h-3" />
                  {t("cancelEdit")}
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {isMasked && (
        // Rendered outside the value column so it doesn't fight the
        // control's width — same row, right-aligned under the control.
        <div className="flex justify-end sm:pl-3">
          <button
            type="button"
            onClick={() => setMaskedEditing(true)}
            className="text-xs text-muted-foreground hover:text-foreground mt-1 inline-flex items-center gap-1"
          >
            <Pencil className="w-3 h-3" />
            {t("editMasked")}
          </button>
        </div>
      )}
    </div>
  );
}

/** Sentinel display: dots + an eye button that reveals the plaintext value
 *  via `useRevealValue(backendId).mutate(path)` (M2b Task 11) — the result
 *  is handed to the PARENT (`FieldRenderer`'s `revealedValue` state) via
 *  `onRevealed`, never stored here or in React Query's cache, so it
 *  survives the transition into "编辑" mode (seeding the edit control) —
 *  see that file's doc comments for the full "reveal ≠ edit" contract. Once
 *  revealed, the eye becomes an eye-off toggle that just clears the parent's
 *  state (`onHide`) — no re-fetch needed to hide again. Also renders an
 *  enabled pencil button that hands control back to `FieldRenderer`
 *  (`maskedEditing`) so the masked value can be replaced WHOLESALE by a
 *  fresh control — never by editing `__ORBIT_MASKED__` text in place. */
function MaskedFieldControl({
  path,
  backendId,
  disabled,
  revealedValue,
  onRevealed,
  onHide,
}: {
  path: string;
  backendId: number | undefined;
  disabled: boolean;
  revealedValue: { value: unknown } | null;
  onRevealed: (value: unknown) => void;
  onHide: () => void;
}) {
  const t = useTranslations("configEditor.field");
  const revealMutation = useRevealValue(backendId);

  const handleToggle = () => {
    if (revealedValue) {
      onHide();
      // M2b final-review minor fix: clear the mutation's own settled
      // `data`/`error` (the just-revealed plaintext, in this case) the
      // instant the user hides it again — paired with `gcTime: 0` on
      // useRevealValue, this is the "reset on hide" half: don't wait for
      // garbage collection to drop a reveal already dismissed from view.
      revealMutation.reset();
      return;
    }
    revealMutation.mutate(path, {
      onSuccess: (result) => onRevealed(result.value),
    });
  };

  const displayText = revealedValue
    ? typeof revealedValue.value === "string"
      ? revealedValue.value
      : JSON.stringify(revealedValue.value)
    : "••••••••";

  return (
    <div className="flex items-center gap-1.5">
      <Input
        value={displayText}
        readOnly
        disabled={!revealedValue}
        aria-label={revealedValue ? t("revealedValue") : t("masked")}
        title={path}
        className={cn("font-mono", !revealedValue && "tracking-widest")}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={handleToggle}
        disabled={disabled || revealMutation.isPending}
        aria-label={revealedValue ? t("hide") : t("reveal")}
        title={disabled ? t("revealDisabledDirty") : revealedValue ? t("hide") : t("reveal")}
        className="shrink-0"
      >
        {revealMutation.isPending ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : revealedValue ? (
          <EyeOff className="w-4 h-4" />
        ) : (
          <Eye className="w-4 h-4" />
        )}
      </Button>
    </div>
  );
}

function FieldControl({
  field,
  value,
  path,
  backendId,
  revealDisabled,
  onChange,
}: {
  field: FieldDescriptor;
  value: unknown;
  path: string;
  backendId: number | undefined;
  revealDisabled?: boolean;
  onChange: (value: unknown) => void;
}) {
  const t = useTranslations("configEditor.field");
  const placeholder = formatPlaceholder(field);

  switch (field.type) {
    case "boolean":
      return (
        <div className="flex h-9 items-center justify-end sm:justify-start">
          <Switch
            checked={!!value}
            onCheckedChange={(checked) => onChange(checked)}
            aria-label={field.label}
          />
        </div>
      );

    case "select": {
      const options = field.options ?? [];
      const selected = typeof value === "string" ? (value === "" ? EMPTY_OPTION_VALUE : value) : undefined;
      return (
        <Select
          value={selected}
          onValueChange={(next) => onChange(next === EMPTY_OPTION_VALUE ? "" : next)}
        >
          <SelectTrigger className="w-full" aria-label={field.label}>
            <SelectValue placeholder={placeholder ?? "—"} />
          </SelectTrigger>
          <SelectContent>
            {options.map((opt) => (
              <SelectItem key={opt || EMPTY_OPTION_VALUE} value={opt === "" ? EMPTY_OPTION_VALUE : opt}>
                {opt === "" ? t("noneOption") : opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }

    case "number":
      return (
        <Input
          type="number"
          value={typeof value === "number" ? value : ""}
          placeholder={placeholder}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") {
              onChange(undefined);
              return;
            }
            const parsed = Number(raw);
            // Mid-typing intermediate state (e.g. a lone "-" while entering
            // a negative number) — deliberately don't call `onChange` at
            // all here. Committing `NaN` would round-trip back through the
            // `typeof value === "number"` check above as true (NaN IS
            // typeof "number") and get handed to a native `type="number"`
            // input as its value, which the browser silently clears —
            // wiping out what the user just typed. Skipping the commit
            // leaves this render's state untouched, so React never
            // re-asserts a `value` prop against the DOM and the browser's
            // own in-progress text survives untouched.
            if (Number.isNaN(parsed)) return;
            onChange(parsed);
          }}
        />
      );

    case "array":
      return (
        <TagInput
          value={Array.isArray(value) ? value : []}
          example={field.example}
          onChange={onChange}
        />
      );

    case "object":
      if (field.nestedFields && field.nestedFields.length > 0) {
        return (
          <NestedObjectFields
            fields={field.nestedFields}
            value={
              value !== null && typeof value === "object" && !Array.isArray(value)
                ? (value as Record<string, unknown>)
                : {}
            }
            parentPath={path}
            backendId={backendId}
            revealDisabled={revealDisabled}
            onChange={onChange}
          />
        );
      }
      // No fixed schema for this object (e.g. dns.nameserver-policy, a
      // free-form domain -> nameserver-list map) — raw JSON editing is the
      // only generic option; `example` becomes the textarea's placeholder,
      // JSON-stringified per the brief.
      return <JsonTextField value={value} example={field.example} onChange={onChange} />;

    case "string":
    case "dialer-proxy":
    default:
      return (
        <Input
          type="text"
          value={typeof value === "string" ? value : ""}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
        />
      );
  }
}

/** Tag-style multi-value input for `type: "array"` fields. A masked array
 *  ELEMENT (yaml-mask.ts's value-equality pass masks individual sequence
 *  entries, not just whole-field values — e.g. one nameserver in a list
 *  that happens to match a masked secret elsewhere) renders as a locked
 *  `•••` chip rather than the literal sentinel string, so removing it is an
 *  informed action rather than a user mistaking `__ORBIT_MASKED__` for real
 *  data. */
function TagInput({
  value,
  example,
  onChange,
}: {
  value: unknown[];
  example?: FieldMetaValue;
  onChange: (value: string[] | undefined) => void;
}) {
  const t = useTranslations("configEditor.field");
  const [draft, setDraft] = useState("");
  const examplePlaceholder = Array.isArray(example) ? example[0] : undefined;

  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onChange([...value.map(String), trimmed]);
    setDraft("");
  };

  const removeAt = (index: number) => {
    const next = value.filter((_, i) => i !== index).map(String);
    onChange(next.length > 0 ? next : undefined);
  };

  return (
    <div className="space-y-1.5">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((item, index) => {
            const isMaskedItem = item === MASKED_SENTINEL;
            return (
              <Badge key={index} variant={isMaskedItem ? "outline" : "secondary"} className="gap-1 pr-1">
                {isMaskedItem ? (
                  <span className="font-mono tracking-widest">•••</span>
                ) : (
                  <span className="max-w-48 truncate">{String(item)}</span>
                )}
                <button
                  type="button"
                  onClick={() => removeAt(index)}
                  className="rounded-full hover:bg-background/60 p-0.5"
                  aria-label={t("removeItem", { item: isMaskedItem ? t("masked") : String(item) })}
                >
                  <X className="w-3 h-3" />
                </button>
              </Badge>
            );
          })}
        </div>
      )}
      <Input
        value={draft}
        placeholder={
          examplePlaceholder !== undefined ? String(examplePlaceholder) : t("addItemPlaceholder")
        }
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          }
        }}
        onBlur={commit}
      />
    </div>
  );
}

/** Raw-JSON control for an `object` field with no `nestedFields` schema.
 *  `draft` (local, uncommitted text) is `null` whenever this control isn't
 *  actively being typed into — in that state the textarea mirrors `value`
 *  directly, so an external reset (masked-field cancel) is reflected
 *  immediately. While `draft` is non-null, every keystroke tries to
 *  `JSON.parse` it: success calls `onChange` with the parsed object (also
 *  clearing the invalid flag), failure just marks `invalid` without
 *  propagating a change — on blur, `draft` resets to `null`, discarding any
 *  still-invalid typed text and reverting the visible text to the last
 *  successfully committed value. */
function JsonTextField({
  value,
  example,
  onChange,
}: {
  value: unknown;
  example?: FieldMetaValue;
  onChange: (value: unknown) => void;
}) {
  const t = useTranslations("configEditor.field");
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);

  const displayText = draft !== null ? draft : value !== undefined ? JSON.stringify(value, null, 2) : "";
  const placeholder = example !== undefined ? JSON.stringify(example, null, 2) : undefined;

  return (
    <div className="space-y-1">
      <textarea
        value={displayText}
        placeholder={placeholder}
        onChange={(e) => {
          const text = e.target.value;
          setDraft(text);
          if (text.trim() === "") {
            setInvalid(false);
            onChange(undefined);
            return;
          }
          try {
            const parsed = JSON.parse(text);
            setInvalid(false);
            onChange(parsed);
          } catch {
            setInvalid(true);
          }
        }}
        onBlur={() => setDraft(null)}
        className={cn(
          "border-input flex w-full min-h-24 rounded-md border bg-transparent px-3 py-2 text-sm font-mono shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
          invalid && "border-destructive focus-visible:ring-destructive/20",
        )}
      />
      {invalid && <p className="text-xs text-destructive">{t("invalidJson")}</p>}
    </div>
  );
}

/** `object` field with a fixed `nestedFields` schema — recurses through
 *  `FieldRenderer` itself. Unreached by Task 8's 5 flat categories (none of
 *  their fields declare `nestedFields`; only the table-category protocol/
 *  type field sets do, e.g. vmess's `ws-opts.headers`) but implemented now
 *  since the brief calls for it and Task 9 reuses this component wholesale.
 *  Dirty tracking stays at the PARENT field's granularity (the top-level
 *  `onChange` this eventually bubbles to is always a category-level
 *  `setFieldValue` keyed by the outer `FieldDescriptor.key`) — individual
 *  nested rows don't show their own dirty dot, matching the fidelity
 *  principle's granularity (whole-field, not sub-leaf). */
function NestedObjectFields({
  fields,
  value,
  parentPath,
  backendId,
  revealDisabled,
  onChange,
}: {
  fields: FieldDescriptor[];
  value: Record<string, unknown>;
  parentPath: string;
  backendId: number | undefined;
  revealDisabled?: boolean;
  onChange: (value: Record<string, unknown>) => void;
}) {
  const siblingValues: Record<string, unknown> = {};
  for (const f of fields) siblingValues[f.key] = value[f.key];

  return (
    <div className="space-y-1 rounded-md border border-border/60 divide-y divide-border/60 px-3">
      {fields.map((nestedField) => (
        <FieldRenderer
          key={nestedField.key}
          field={nestedField}
          value={value[nestedField.key]}
          path={`${parentPath}.${nestedField.key}`}
          siblingValues={siblingValues}
          dirty={false}
          backendId={backendId}
          revealDisabled={revealDisabled}
          onChange={(v) => onChange({ ...value, [nestedField.key]: v })}
          onReset={() => {
            const next = { ...value };
            delete next[nestedField.key];
            onChange(next);
          }}
        />
      ))}
    </div>
  );
}
