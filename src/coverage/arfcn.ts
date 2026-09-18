/**
 * Channel-number to centre-frequency conversion for cellular observations.
 *
 * WiGLE cell rows carry a channel number (E-UTRA EARFCN for LTE rows, NR-ARFCN for NR rows) but never a
 * frequency. The conversions below are the fixed 3GPP rasters (TS 36.101 for E-UTRA, TS 38.104 for NR),
 * so a frequency derived here is arithmetic on an observed channel number, not an invented value. Every
 * derived frequency is labelled with its source so it is never mistaken for a measured one.
 */

type Band = { band: number; low: number; high: number; fLowMHz: number };

/** Downlink E-UTRA bands relevant to US carriers, from TS 36.101 table 5.7.3-1. */
const EUTRA_DOWNLINK: Band[] = [
  { band: 1, low: 0, high: 599, fLowMHz: 2110 },
  { band: 2, low: 600, high: 1199, fLowMHz: 1930 },
  { band: 3, low: 1200, high: 1949, fLowMHz: 1805 },
  { band: 4, low: 1950, high: 2399, fLowMHz: 2110 },
  { band: 5, low: 2400, high: 2649, fLowMHz: 869 },
  { band: 7, low: 2750, high: 3449, fLowMHz: 2620 },
  { band: 8, low: 3450, high: 3799, fLowMHz: 925 },
  { band: 12, low: 5010, high: 5179, fLowMHz: 729 },
  { band: 13, low: 5180, high: 5279, fLowMHz: 746 },
  { band: 14, low: 5280, high: 5379, fLowMHz: 758 },
  { band: 17, low: 5730, high: 5849, fLowMHz: 734 },
  { band: 20, low: 6150, high: 6449, fLowMHz: 791 },
  { band: 25, low: 8040, high: 8689, fLowMHz: 1930 },
  { band: 26, low: 8690, high: 9039, fLowMHz: 859 },
  { band: 29, low: 9660, high: 9769, fLowMHz: 717 },
  { band: 30, low: 9770, high: 9869, fLowMHz: 2350 },
  { band: 38, low: 37750, high: 38249, fLowMHz: 2570 },
  { band: 40, low: 38650, high: 39649, fLowMHz: 2300 },
  { band: 41, low: 39650, high: 41589, fLowMHz: 2496 },
  { band: 46, low: 46790, high: 54539, fLowMHz: 5150 },
  { band: 48, low: 55240, high: 56739, fLowMHz: 3550 },
  { band: 66, low: 66436, high: 67335, fLowMHz: 2110 },
  { band: 71, low: 68586, high: 68935, fLowMHz: 617 },
];

export type ChannelFrequency = {
  frequencyMHz: number;
  source: "DERIVED_EARFCN" | "DERIVED_NR_ARFCN";
  band: number | null;
};

/** Null when the channel number is outside the tabulated rasters; an unknown frequency stays unknown. */
export function eutraFrequencyMHz(earfcn: number): ChannelFrequency | null {
  if (!Number.isInteger(earfcn) || earfcn < 0) return null;
  const band = EUTRA_DOWNLINK.find((entry) => earfcn >= entry.low && earfcn <= entry.high);
  if (!band) return null;
  return { frequencyMHz: Number((band.fLowMHz + 0.1 * (earfcn - band.low)).toFixed(3)), source: "DERIVED_EARFCN", band: band.band };
}

/** NR global frequency raster: 5 kHz steps below 3 GHz, 15 kHz to 24.25 GHz, 60 kHz above. */
export function nrFrequencyMHz(arfcn: number): ChannelFrequency | null {
  if (!Number.isInteger(arfcn) || arfcn < 0 || arfcn > 3_279_165) return null;
  let frequencyMHz: number;
  if (arfcn < 600_000) frequencyMHz = 0.005 * arfcn;
  else if (arfcn < 2_016_667) frequencyMHz = 3000 + 0.015 * (arfcn - 600_000);
  else frequencyMHz = 24_250.08 + 0.06 * (arfcn - 2_016_667);
  if (frequencyMHz < 1 || frequencyMHz > 100_000) return null;
  return { frequencyMHz: Number(frequencyMHz.toFixed(3)), source: "DERIVED_NR_ARFCN", band: null };
}

/** Selects the appropriate cellular raster, preserving a missing channel as an unknown frequency. */
export function channelFrequencyMHz(rat: "LTE" | "NR", channel: number | null | undefined): ChannelFrequency | null {
  if (channel === null || channel === undefined) return null;
  return rat === "LTE" ? eutraFrequencyMHz(channel) : nrFrequencyMHz(channel);
}
