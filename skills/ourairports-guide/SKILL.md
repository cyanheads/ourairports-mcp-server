---
name: ourairports-guide
description: Use the ourairports_* tools to resolve ambiguous airport and navaid codes, follow airport associations, or compile a runway inventory from the OurAirports snapshot.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Identifiers

- Use the selected airport's `ident` from an airport search, a runway result, or `ourairports_get_airport` for follow-up calls. A shared IATA, ICAO, GPS, or local code can resolve to another airport.
- A navaid's `associatedAirport`, when present, is an airport `ident` you can pass to `ourairports_get_airport`. A navaid's own `ident` may identify several facilities.
- Get country and region filter codes from `ourairports_list_countries`. Request regions within the country when you know it.

## Gates

- Before using a code lookup result, check the airport name, country, and `resolutionNote` against the request. When the note identifies the intended airport as another holder, look up that airport by its `ident`.
- Keep the query and data snapshot unchanged when following `nextOffset`. Restart from the first page after a dataset refresh. Read through the final page before claiming a complete inventory or a unique match in the filtered snapshot.
- Use runway dimensions and runway-end coordinates as reference data. End coordinates mark the centers of the runway ends, with displacement recorded separately. Length covers the full runway surface. Use current official sources for declared distances, threshold positions, and operational suitability.

## Workflows

- **Airport by name or code.** Use `ourairports_get_airport` when you have an explicit code. For a name or municipality, use `ourairports_search_airports`, select the intended airport, then fetch details by its `ident`. When searching by code to compare candidates, inspect their returned code fields because text matches can also appear. If search reports no searchable terms for punctuation or stopwords, supply meaningful text or omit the query to browse by facets.
- **Navaid by ident or airport.** Use exact ident mode in `ourairports_find_navaids` for a navaid code. Compare type, country, and coordinates before selecting among holders. For aids serving an airport, use airport mode with the resolved airport's `ident`. Use coordinate mode to look for nearby aids regardless of their airport association.
- **Runway inventory.** Resolve any geographic facets, then page through `ourairports_search_runways`. Count distinct `airport.ident` values for an airport total because each result is a runway. In a radius search, interpret distance as distance to the airport reference coordinates.
