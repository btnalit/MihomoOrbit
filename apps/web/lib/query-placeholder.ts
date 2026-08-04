type IdentityValue = string | number | boolean | null;
type Identity = Record<string, IdentityValue>;

type QueryLike = {
  queryKey?: readonly unknown[];
};

function getQueryIdentityPayload(previousQuery: QueryLike | undefined): Record<string, unknown> | null {
  const payload = previousQuery?.queryKey?.[2];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  return payload as Record<string, unknown>;
}

export function keepPreviousByIdentity<TData>(
  previousData: TData | undefined,
  previousQuery: QueryLike | undefined,
  identity: Identity,
): TData | undefined {
  const payload = getQueryIdentityPayload(previousQuery);
  if (!payload) return undefined;

  for (const [key, expected] of Object.entries(identity)) {
    if (payload[key] !== expected) {
      return undefined;
    }
  }

  return previousData;
}
