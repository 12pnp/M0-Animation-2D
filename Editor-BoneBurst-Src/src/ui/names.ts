/** `base`, or `base2`, `base3`… the first not in `taken`. */
export function uniqueName(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}${n}`)) n++;
  return `${base}${n}`;
}
