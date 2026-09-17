export interface CarrierProfile {
  name: "AT&T" | "T-Mobile" | "Verizon";
  operator: string;
  mcc: "310" | "311";
  mnc: string;
  apn: string;
  apnType: string;
}

export const US_CARRIERS: CarrierProfile[] = [
  { name: "AT&T", operator: "AT&T", mcc: "310", mnc: "410", apn: "nxtgenphone", apnType: "default,supl,hipri" },
  { name: "T-Mobile", operator: "T-Mobile USA", mcc: "310", mnc: "260", apn: "fast.t-mobile.com", apnType: "default,supl,hipri" },
  { name: "Verizon", operator: "Verizon Wireless", mcc: "311", mnc: "480", apn: "vzwinternet", apnType: "default,supl,hipri" },
];

const SECONDARY: Record<string, "AT&T" | "T-Mobile" | "Verizon" | "geo"> = {
  "410": "AT&T",
  "260": "T-Mobile",
  "480": "Verizon",
  "120": "T-Mobile",
  "012": "Verizon",
  "12": "Verizon",
  "270": "Verizon",
  "580": "geo",
};

export function normalizeToCoreCarrier(
  raw?: string,
): "AT&T" | "T-Mobile" | "Verizon" | "geo" | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase().replace(/^310-|^311-/, "");
  if (key === "at&t" || key === "att") return "AT&T";
  if (key === "t-mobile" || key === "tmobile" || key === "sprint") return "T-Mobile";
  if (key === "verizon") return "Verizon";
  if (key === "us cellular" || key === "uscellular") return "geo";
  return SECONDARY[key] ?? null;
}

export function carrierByName(name?: string): CarrierProfile {
  const mapped = normalizeToCoreCarrier(name);
  if (mapped && mapped !== "geo") {
    return US_CARRIERS.find((c) => c.name === mapped) ?? US_CARRIERS[1]!;
  }
  const found = US_CARRIERS.find(
    (c) => c.name.toLowerCase() === (name ?? "").toLowerCase() || c.mnc === name,
  );
  return found ?? US_CARRIERS[1]!;
}

export function randomUsCellIds(): { lac: number; cid: number } {
  return {
    lac: 10_000 + Math.floor(Math.random() * 20_000),
    cid: 10_000 + Math.floor(Math.random() * 90_000),
  };
}
