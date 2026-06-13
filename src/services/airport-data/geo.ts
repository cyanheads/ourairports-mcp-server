/**
 * @fileoverview Great-circle geospatial helpers for the nearest-neighbour
 * scans. Brute-force haversine over a flat coordinate array is sub-millisecond
 * at this dataset's scale (~85k airports, ~11k navaids), so no spatial index.
 * @module src/services/airport-data/geo
 */

const EARTH_RADIUS_KM = 6371.0088;
const DEG_TO_RAD = Math.PI / 180;

/** Great-circle distance in km between two lat/lon points (haversine). */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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

/**
 * Scan a flat `[lat, lon, lat, lon, …]` coordinate array, keep entries within
 * `radiusKm` that pass `accept(index)`, and return the nearest `limit` by
 * distance. Sorts only the surviving in-radius set (typically small), not the
 * whole corpus.
 */
export function nearest(
  coords: Float64Array,
  originLat: number,
  originLon: number,
  radiusKm: number,
  limit: number,
  accept: (index: number) => boolean,
): DistanceHit[] {
  const hits: DistanceHit[] = [];
  const count = coords.length / 2;
  for (let i = 0; i < count; i++) {
    if (!accept(i)) continue;
    const lat = coords[i * 2] as number;
    const lon = coords[i * 2 + 1] as number;
    const d = haversineKm(originLat, originLon, lat, lon);
    if (d <= radiusKm) hits.push({ index: i, distanceKm: d });
  }
  hits.sort((a, b) => a.distanceKm - b.distanceKm);
  return hits.slice(0, limit);
}
