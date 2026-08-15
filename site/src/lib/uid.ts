// Deterministic per-build ids for inline SVG defs. Using a counter rather than
// Math.random() keeps the built HTML byte-stable across rebuilds.
let n = 0;
export function nextId(prefix: string): string {
  n += 1;
  return `${prefix}${n}`;
}
