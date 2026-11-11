/**
 * @fileoverview Great-circle geospatial helpers for the nearest-neighbour
 * scans. Brute-force haversine over a flat coordinate array takes a few
 * milliseconds at this dataset's scale (~85k airports, ~11k navaids), so no
 * spatial index.
 * @module src/services/airport-data/geo
 */

import { RankedPage } from './ranked-page.js';

const EARTH_RADIUS_KM = 6371.0088;
const DEG_TO_RAD = Math.PI / 180;

/** Integer radius in kilometers large enough to include an antipodal point. */
export const MAX_RADIUS_KM = Math.ceil(Math.PI * EARTH_RADIUS_KM);

/** Great-circle distance in km between two lat/lon points (haversine). */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * Math.sin(dLon / 2) ** 2;
  const bounded = Math.min(1, a);
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(bounded), Math.sqrt(1 - bounded));
}

/** Initial bearing in degrees (0–360, clockwise from true north) from point 1 to point 2. */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const φ1 = lat1 * DEG_TO_RAD;
  const φ2 = lat2 * DEG_TO_RAD;
  const Δλ = (lon2 - lon1) * DEG_TO_RAD;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);
  return (θ / DEG_TO_RAD + 360) % 360;
}

/** A scan candidate: an entity index paired with its computed distance. */
export interface DistanceHit {
  distanceKm: number;
  index: number;
}

/** The nearest in-radius hits (capped) and how many matched before the cap. */
export interface NearestResult {
  hits: DistanceHit[];
  /** In-radius entries that passed `accept`, counted before the `limit` cap. */
  total: number;
}

/**
 * Scan a flat `[lat, lon, lat, lon, …]` coordinate array, keep entries within
 * `radiusKm` that pass `accept(index)` and return a distance-ranked page
 * and the filtered total. Equal distances follow coordinate array order.
 */
export function nearest(
  coords: Float64Array,
  originLat: number,
  originLon: number,
  radiusKm: number,
  limit: number,
  accept: (index: number) => boolean,
  offset = 0,
): NearestResult {
  const page = new RankedPage<DistanceHit>(
    limit,
    offset,
    (a, b) => a.distanceKm - b.distanceKm || a.index - b.index,
  );
  let total = 0;
  const count = coords.length / 2;
  for (let i = 0; i < count; i++) {
    if (!accept(i)) continue;
    const lat = coords[i * 2] as number;
    const lon = coords[i * 2 + 1] as number;
    const d = haversineKm(originLat, originLon, lat, lon);
    if (d <= radiusKm) {
      total++;
      page.offer({ index: i, distanceKm: d });
    }
  }
  return { hits: page.rows(), total };
}
