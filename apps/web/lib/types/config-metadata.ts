/**
 * Types for `public/config-metadata.json` — copied verbatim from
 * clash-cfg-edit-1.0.0/frontend/public/config-metadata.json (25,335 bytes,
 * 8 categories). Modeled by reading the actual JSON shape, not invented:
 *
 * - `basic`/`network`/`tun`/`dns`/`sniffer` are flat categories: just an
 *   array of `FieldDescriptor` under `fields`.
 * - `proxies`/`proxy-groups`/`rules` are `isTable: true` categories, each
 *   with its own per-type field-set array (`protocols`/`types`/`ruleTypes`
 *   respectively) instead of a flat `fields` array.
 * - `FieldDescriptor.type` is one of: string/number/boolean/select/array/
 *   object/dialer-proxy. `select`/checking `options` is only present for
 *   `type: "select"`. `nestedFields` (only ever seen on `type: "object"`)
 *   recurses with the same `FieldDescriptor` shape — depth 2 in the source
 *   file (e.g. proxies/vmess ws-opts.headers).
 * - `showWhen` is always `{ field: string; value: boolean | string }`
 *   (verified against all 18 occurrences in the source file) — the field
 *   named by `field` lives in the SAME field-set as the conditional field.
 *
 * This file has no runtime logic — it exists purely so Tasks 8-11 can
 * import `ConfigMetadata`/`Category`/`FieldDescriptor` instead of typing
 * `unknown` against the fetched JSON.
 */

export type FieldType =
  | "string"
  | "number"
  | "boolean"
  | "select"
  | "array"
  | "object"
  | "dialer-proxy";

export interface FieldShowWhen {
  field: string;
  value: boolean | string;
}

/** `default`/`example` value shapes observed across the whole source file:
 *  string/number/boolean/string[] cover every case except one — `dns.
 *  nameserver-policy`'s `example` is a nested object (`{ "geosite:cn":
 *  [...], ... }`), hence `Record<string, unknown>`. Verified by a full
 *  `node -e` walk over every field/nestedFields/protocols/types entry in
 *  the source JSON (see task-7-report.md's fix note for the walk output);
 *  `default` never hits the object case in the current data but shares the
 *  type for consistency, since both are free-form JSON values in principle. */
export type FieldMetaValue = string | number | boolean | string[] | Record<string, unknown>;

export interface FieldDescriptor {
  key: string;
  label: string;
  type: FieldType;
  /** Present only for `type: "select"`. */
  options?: string[];
  default?: FieldMetaValue;
  description?: string;
  example?: FieldMetaValue;
  required?: boolean;
  /** Conditional visibility: show this field only when `field` in the same
   *  field-set currently has `value`. */
  showWhen?: FieldShowWhen;
  /** Present only for `type: "object"` — recurses with the same shape
   *  (source file nests to depth 2, e.g. proxies/vmess ws-opts.headers). */
  nestedFields?: FieldDescriptor[];
}

/** One entry of `proxies` category's `protocols[]` — one proxy protocol's
 *  (ss/vmess/trojan/...) field set. */
export interface ProxyProtocolFieldSet {
  type: string;
  label: string;
  fields: FieldDescriptor[];
}

/** One entry of `proxy-groups` category's `types[]` — one group type's
 *  (select/url-test/fallback/...) field set. */
export interface ProxyGroupTypeFieldSet {
  type: string;
  label: string;
  fields: FieldDescriptor[];
}

/** One entry of `rules` category's `ruleTypes[]` — a rule type (DOMAIN,
 *  DOMAIN-SUFFIX, ...) has a label and whether it takes a `payload` value;
 *  it has no `fields` array of its own (rules are not object-shaped). */
export interface RuleTypeDescriptor {
  type: string;
  label: string;
  hasValue: boolean;
}

/** A flat category: `basic`/`network`/`tun`/`dns`/`sniffer`. */
export interface FlatCategory {
  id: string;
  name: string;
  icon: string;
  isTable?: undefined;
  fields: FieldDescriptor[];
}

/** A table-shaped category: `proxies`/`proxy-groups`/`rules`. Each has its
 *  own per-type field-set array instead of a flat `fields` array — only
 *  the one matching this category's `id` is ever populated. */
export interface TableCategory {
  id: string;
  name: string;
  icon: string;
  isTable: true;
  description?: string;
  /** Populated only when `id === "proxies"`. */
  protocols?: ProxyProtocolFieldSet[];
  /** Populated only when `id === "proxy-groups"`. */
  types?: ProxyGroupTypeFieldSet[];
  /** Populated only when `id === "rules"`. */
  ruleTypes?: RuleTypeDescriptor[];
}

export type Category = FlatCategory | TableCategory;

export interface ConfigMetadata {
  categories: Category[];
}
