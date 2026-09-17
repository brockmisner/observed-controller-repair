import axios from "axios";
import { logger } from "../logger.js";
import { carrierByName, type CarrierProfile } from "./carriers.js";

export interface IspHint {
  ip: string;
  isp: string;
  org: string;
  asn: string;
  kind: "mobile" | "residential" | "unknown";
  carrier: CarrierProfile;
  normalize: "AT&T" | "T-Mobile" | "Verizon" | "geo";
  timezone: string;
  language: string;
  city: string;
  region: string;
  countryCode: string;
}

const MOBILE_ATT = /\b(at&?t|att mobility|cricket|sbc internet|bellsouth|310-?410)\b/i;
const MOBILE_VZW =
  /\b(verizon|cellco|fios.*wireless|mci communications|310-?012|311-?270|311-?480)\b/i;
const MOBILE_TMO =
  /\b(t-?mobile|sprint|metro(?:pcs)? by t-mobile|assurance wireless|310-?260|310-?120)\b/i;
const MOBILE_USC = /\b(u\.?s\.? cellular|uscellular|united states cellular|311-?580)\b/i;
const RESIDENTIAL =
  /\b(comcast|xfinity|spectrum|charter|cox|optimum|altice|centurylink|lumen|frontier|windstream|mediacom|wow internet|google fiber|astound|rcn)\b/i;

const LANG: Record<string, string> = {
  US: "en-US",
  GB: "en-GB",
  CA: "en-CA",
  AU: "en-AU",
  MX: "es-MX",
  ES: "es-ES",
  FR: "fr-FR",
  DE: "de-DE",
};

export function languageFromCountry(code: string): string {
  return LANG[code.toUpperCase()] ?? "en-US";
}

export function asnKey(asn: string): string {
  const m = asn.match(/AS\d+/i);
  return (m?.[0] ?? asn).toUpperCase();
}

export function carrierFromIspText(text: string, residentialFallback: string): CarrierProfile {
  const blob = text.toLowerCase();
  if (MOBILE_ATT.test(blob)) return carrierByName("AT&T");
  if (MOBILE_VZW.test(blob)) return carrierByName("Verizon");
  if (MOBILE_TMO.test(blob) || /\bsprint\b/.test(blob)) return carrierByName("T-Mobile");
  if (MOBILE_USC.test(blob)) return carrierByName("geo");
  return carrierByName(residentialFallback);
}

export function classifyKind(text: string): IspHint["kind"] {
  if (MOBILE_ATT.test(text) || MOBILE_VZW.test(text) || MOBILE_TMO.test(text) || MOBILE_USC.test(text)) {
    return "mobile";
  }
  if (RESIDENTIAL.test(text)) return "residential";
  return "unknown";
}

export async function lookupProxyIsp(
  ip: string,
  residentialFallback = "T-Mobile",
): Promise<IspHint | null> {
  const clean = ip?.trim();
  if (!clean || clean === "127.0.0.1" || clean.startsWith("10.") || clean.startsWith("192.168.")) {
    return null;
  }
  try {
    const { data } = await axios.get(`http://ip-api.com/json/${encodeURIComponent(clean)}`, {
      timeout: 8_000,
      params: {
        fields: "status,message,isp,org,as,asname,query,timezone,city,regionName,countryCode",
      },
    });
    if (data?.status !== "success") {
      logger.warn({ ip: clean, message: data?.message }, "ISP lookup failed");
      return null;
    }
    const blob = [data.isp, data.org, data.as, data.asname].filter(Boolean).join(" ");
    const countryCode = String(data.countryCode ?? "US");
    const carrier = carrierFromIspText(blob, residentialFallback);
    const normalize: IspHint["normalize"] = MOBILE_USC.test(blob)
      ? "geo"
      : carrier.name;
    return {
      ip: data.query ?? clean,
      isp: String(data.isp ?? data.org ?? "unknown"),
      org: String(data.org ?? ""),
      asn: String(data.as ?? data.asname ?? ""),
      kind: classifyKind(blob),
      carrier,
      normalize,
      timezone: String(data.timezone || "America/New_York"),
      language: languageFromCountry(countryCode),
      city: String(data.city ?? ""),
      region: String(data.regionName ?? ""),
      countryCode,
    };
  } catch (err) {
    logger.warn({ err, ip: clean }, "ISP lookup error");
    return null;
  }
}
