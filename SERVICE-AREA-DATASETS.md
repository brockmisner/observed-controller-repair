# Service-area datasets

A client service area is a 5–10 mile radius holding several phones that move independently. The area's
WiGLE observations are downloaded once, stored as a reusable dataset, and refreshed rarely. This document
covers how that dataset is stored, how a phone reads only its own neighbourhood, and what the saved data
can and cannot support.

## Why tiles

The radio engine parses at most 10,000 observations per session, and the older city import stored one JSON
document per area with the same limit. A 7-mile radius over a dense coastal city does not fit either.

A dataset revision is therefore stored as tiles: `AreaDatasetTile` rows keyed by revision, kind and tile
key. Wi-Fi and Bluetooth use the base tile grid (zoom 15 ≈ 1.2 km); cell observations, which are far
sparser but needed out to a 3 km radius, use a grid three zoom levels coarser. A phone loads the tiles
intersecting its own reception radii and nothing else, from the database and a shared in-process cache.
No external query happens on a movement tick.

## Bounded windows without dropping coverage

`loadWindow` serves each kind at the engine's own reception radius plus a travel margin, so the phone can
keep moving before the next load. When the record count exceeds the session limit, the margin shrinks —
never the radius — and the response states how far the phone may travel before reloading. If even the
smallest supported margin does not fit, the load fails loudly instead of truncating coverage.

Measured with generated observations (`npm run area -- bench`), 11.3 km radius, zoom 15:

| Dataset | Tiles | Window (570 m) | Cold load | Warm load | Ingest |
| --- | --- | --- | --- | --- | --- |
| 200,000 records, uniform | 367 | 512 records | 20 ms | 10 ms | ~8,100 records/s |
| 300,000 records in a 2 km radius (≈24,000/km²) | 19 at zoom 15 | 24,290 → margin reduced to 225 m → 8,950 records | 408 ms | 75 ms | ~14,900 records/s |
| the same at zoom 17 | 193 | same 8,950 records | 180 ms | 89 ms | ~9,700 records/s |

Storage is roughly 280 bytes per observation, so a 400,000-record area is about 110 MB of SQLite.
Dense areas should use a smaller tile zoom; the per-kind offset keeps the cell grid coarse regardless.

## Revisions and refreshes

Each ingest builds a new revision beside the active one. Runs pin `datasetRevision` (`<datasetId>:<n>`),
which is what the engine already carries, so publishing a refresh cannot change an active phone's world.
Only `COMPLETE` revisions are served; a revision under construction is never handed to a run. Cached
tiles are frozen and keyed by revision, so phones share source observations without sharing state.

## Source licensing, before any of this is used

WiGLE's EULA grants use of its database "solely for your personal, research or educational,
non-commercial purposes" and forbids copying or distributing the data "in its entirety or in any part for
any commercial consideration". Commercial licensing exists in principle but is suspended, and WiGLE
publishes no bulk export of other people's observations. Building a paid client's service area out of
WiGLE search results is therefore outside that licence, whatever the request budget allows.

The tooling here is source-agnostic: it ingests normalized observations, records the file or query cell
behind each one, and keeps provenance per revision. Lawful sources for the same pipeline include
observations you collected yourself with the WiGLE app (yours to keep, re-downloadable per upload),
OpenCelliD's CC BY-SA bulk cell CSV, and commercially licensed on-premise datasets. Pick the source
before planning an ingest.

## Resumable WiGLE ingest

WiGLE returns 100 rows per page with a `searchAfter` cursor (`first` is not a supported paging parameter)
and enforces a per-account daily query allowance that it deliberately does not publish; it is
history-based and resets at 00:00 US/Pacific, which is the day boundary this ingest counts against. Over
quota, the API answers HTTP 429 "Too many queries today" — this project's own captures include the JSON
form, `{"success": false, "message": "too many queries today"}` — and a commercial token answers HTTP 402
"Insufficient balance". Both pause an ingest and keep its progress.

`npm run area -- fetch` splits the area into per-cell, per-kind query units, each with its own cursor,
merges every page into the revision before the next request, and treats the daily-limit response as a
pause that keeps all progress. Resuming continues from the stored cursors. `npm run area -- plan` prints
the query-cell grid and the request estimate before any allowance is spent.

`totalResults` is only meaningful on a properly bounded bbox query: an unbounded Wi-Fi search in these
captures reported 294,975,645 results — the whole corpus — while a bounded cell search reported 134.
Ingest flags such responses rather than using them for capacity planning.

## What the data supports

- **Wi-Fi** rows carry BSSID, SSID, channel, frequency, encryption, `firsttime`/`lasttime`/`lastupdt`,
  `qos` and `transid`. All of that is preserved. Rows with no SSID stay unusable rather than being given
  a placeholder, and a missing frequency is derived from the channel only on the unambiguous 2.4/5 GHz
  channel plans, labelled as derived.
- **Cellular** rows carry identity in the `PLMN_AREA_CELL` key, a channel number, and no frequency,
  transmit power or antenna information. The PLMN is MCC and MNC concatenated to six digits, and WiGLE
  does not distinguish LAC from TAC, so the parsed area code holds whichever the source recorded.
  Identity is parsed from that key — never decoded out of the cell number — and the RAT comes from `attributes`/`type`, because `gentype` is unreliable (an NR row arrived
  with `gentype: "WCDMA"`). LTE and NR frequencies are derived from EARFCN/NR-ARFCN through the fixed
  3GPP rasters. Path loss still has no source, so cells become model-usable only with an explicitly
  declared scenario (`--cellScenario`), and sector orientation remains an explicit unknown. GSM, WCDMA
  and CDMA rows are stored as real coverage the LTE/NR model cannot use.
- **Bluetooth** rows are historical BLE sightings with rotating names and addresses. They can model an
  arrival update; they are not evidence of a current physical discovery.

Per-observation confidence combines `qos` with the last sighting date, and reports catalogue freshness
(`lastupdt`) separately, so a recently re-catalogued 2018 sighting is not mistaken for recent coverage.

## Commands

```
npm run area -- plan     --center=25.784,-80.136 --radiusM=11265 --cellSizeM=1000 --dailyBudget=2000
npm run area -- ingest   --name=miami-beach --center=... --radiusM=11265 --dir=./responses [--cellScenario=f.json] [--activate=true]
npm run area -- fetch    --name=miami-beach --center=... --radiusM=11265 [--maxRequests=100]
npm run area -- status   --jobId=...
npm run area -- activate --name=miami-beach --revision=2
npm run area -- report   --name=miami-beach --deviceIds=a,b --route="lat,lng;lat,lng" --arrivals="lat,lng"
npm run area -- window   --name=miami-beach --at=lat,lng
npm run area -- audit    [--deviceId=...]
```

`report` exits non-zero when the verdict is `NOT_SUPPORTED`, so it can gate an acceptance run. The same
data is available read-only over HTTP: `GET /api/coverage/areas`, `POST /api/coverage/report`,
`POST /api/coverage/plan`, `GET /api/coverage/areas/:id/pin`, `GET /api/coverage/areas/:id/tile`,
`GET /api/coverage/ingest/:jobId` and `POST /api/coverage/imports/audit`.

Verification: `npm test`, `npm run test:area`, `npm run build`.
