/**
 * @fileoverview Bounded selection of a page from a ranked scan.
 * @module src/services/airport-data/ranked-page
 */

/** Keeps the worst retained candidate at the root so it can be displaced in O(log n). */
export class RankedPage<T> {
  private readonly candidates: T[] = [];
  private readonly capacity: number;
  private readonly offset: number;
  private readonly compare: (a: T, b: T) => number;

  constructor(limit: number, offset: number, compare: (a: T, b: T) => number) {
    this.capacity = offset + limit;
    this.offset = offset;
    this.compare = compare;
  }

  /** The candidate that must be displaced once the page's prefix is full. */
  get worst(): T | undefined {
    return this.candidates.length === this.capacity ? this.candidates[0] : undefined;
  }

  offer(candidate: T): void {
    const { candidates, compare } = this;
    if (candidates.length < this.capacity) {
      let child = candidates.length;
      candidates.push(candidate);
      while (child > 0) {
        const parent = Math.floor((child - 1) / 2);
        const value = candidates[parent] as T;
        if (compare(value, candidate) >= 0) break;
        candidates[child] = value;
        child = parent;
      }
      candidates[child] = candidate;
      return;
    }

    const worst = candidates[0];
    if (worst === undefined || compare(candidate, worst) >= 0) return;
    let parent = 0;
    while (parent * 2 + 1 < candidates.length) {
      let child = parent * 2 + 1;
      if (
        child + 1 < candidates.length &&
        compare(candidates[child + 1] as T, candidates[child] as T) > 0
      )
        child++;
      const value = candidates[child] as T;
      if (compare(candidate, value) >= 0) break;
      candidates[parent] = value;
      parent = child;
    }
    candidates[parent] = candidate;
  }

  rows(): T[] {
    if (this.offset >= this.candidates.length) return [];
    const ordered = this.candidates.sort(this.compare);
    return this.offset === 0 ? ordered : ordered.slice(this.offset);
  }
}
