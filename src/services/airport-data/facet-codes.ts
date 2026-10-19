/**
 * @fileoverview Source-compatible country and region code shapes.
 * @module src/services/airport-data/facet-codes
 */

/** Two-letter country codes, including OurAirports-specific entries. */
export const COUNTRY_CODE_PATTERN = /^[A-Za-z]{2}$/;

/** One or two region segments; membership comes from regions.csv, not its prefix. */
export const REGION_CODE_PATTERN = /^[A-Za-z]{2}(-[A-Za-z0-9]{1,3}){1,2}$/;
