import { createHash } from "node:crypto";
import { carrierByName, type CarrierProfile } from "./carriers.js";

function digitsFrom(seed: string, n: number): string {
  return createHash("sha256")
    .update(seed)
    .digest("hex")
    .replace(/\D/g, "7")
    .slice(0, n)
    .padEnd(n, "0");
}

export function simIdentifiers(imageId: string, carrier: CarrierProfile): { imsi: string; iccid: string; msin: string } {
  const msin = digitsFrom(`msin:${imageId}:${carrier.mnc}`, 9);
  const imsi = `${carrier.mcc}${carrier.mnc}${msin}`.slice(0, 15);
  const issuer =
    carrier.name === "AT&T" ? "014" : carrier.name === "Verizon" ? "012" : "026";
  const account = digitsFrom(`iccid:${imageId}:${carrier.mnc}`, 12);
  const body = `89${issuer}${account}`.slice(0, 18);
  const iccid = luhnPad(body);
  return { imsi, iccid, msin };
}

function luhnPad(body: string): string {
  let sum = 0;
  let alt = true;
  for (let i = body.length - 1; i >= 0; i--) {
    let n = Number(body[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return body + String((10 - (sum % 10)) % 10);
}

export function carrierForUnknownIsp(lat: number, lng: number): CarrierProfile {
  if (lng < -100) return carrierByName("Verizon");
  if (lat >= 24 && lat <= 31.5 && lng >= -88 && lng <= -79.5) return carrierByName("T-Mobile");
  return carrierByName("T-Mobile");
}
