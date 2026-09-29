const nilValues = [null, undefined] as const;
export function isNil(value: any, ...or: any[]): value is null | undefined {
  return nilValues.concat(or ?? []).includes(value);
}

function camelToLowerDashCase(str: string) {
  if (str != str.toLowerCase()) {
    str = str.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
  }
  return str;
}

export function buildDataset(obj: Record<string, unknown> | null | undefined) {
  if (!obj) {
    return {};
  }

  return Object.entries(obj).reduce<Record<string, unknown>>(
    (acc, [key, value]) => {
      acc[`data-${camelToLowerDashCase(key)}`] = value;
      return acc;
    },
    {}
  );
}

/**
 * Whether an item's `system.advancement` holds any entries. dnd5e 5.2+ made it an
 * AdvancementCollection (`.size`; `.length` is a deprecated shim) on documents and a
 * plain id-keyed object in `toObject()` data, where `.length` is simply undefined -
 * so a `.length` test silently skipped the AdvancementManager on every drop.
 * Older dnd5e uses an array. Handled explicitly (not via `foundry.utils.isEmpty`)
 * so the result does not depend on which core generation's type detection runs.
 */
export function hasAdvancement(advancement: unknown): boolean {
  if (advancement == null) return false;
  if (Array.isArray(advancement)) return advancement.length > 0;
  if (typeof (advancement as any).size === 'number') {
    return (advancement as any).size > 0;
  }
  if (typeof advancement === 'object') {
    return Object.keys(advancement as object).length > 0;
  }
  return false;
}
