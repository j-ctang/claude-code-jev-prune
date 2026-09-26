/** Inserts or refreshes `key` as most recent, evicting the oldest past `max`. */
export function remember<V>(
  map: Map<string, V>,
  key: string,
  value: V,
  max: number,
): void {
  if (max <= 0) return;
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}
