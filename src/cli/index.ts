import { registerDevice, startNavigation, parkStationary, queueSearch } from "../orchestrator/registry.js";
import { prisma } from "../db.js";

const [cmd, ...args] = process.argv.slice(2);

function arg(name: string, fallback?: string): string {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (!hit) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing --${name}=`);
  }
  return hit.slice(name.length + 3);
}

async function main(): Promise<void> {
  switch (cmd) {
    case "register": {
      const tenantId = arg("tenantId", "") || (await prisma.tenant.findFirst())?.id;
      if (!tenantId) throw new Error("No tenant. Sign up in the UI first or pass --tenantId=");
      const device = await registerDevice({
        tenantId,
        imageId: arg("imageId"),
        name: arg("name", ""),
        anchorLat: Number(arg("lat")),
        anchorLng: Number(arg("lng")),
        groundElevationM: Number(arg("elev", "20")),
        timezone: arg("timezone", "America/New_York"),
        wifiSsid: arg("ssid", ""),
        wifiBssid: arg("bssid", ""),
        lookupWigle: arg("wigle", "true") !== "false",
        carrier: arg("carrier", "T-Mobile"),
        campaignDays: Number(arg("days", "30")),
      });
      console.log(JSON.stringify(device, null, 2));
      break;
    }
    case "list": {
      console.log(JSON.stringify(await prisma.device.findMany(), null, 2));
      break;
    }
    case "navigate": {
      const device = await startNavigation(
        arg("imageId"),
        { lat: Number(arg("destLat")), lng: Number(arg("destLng")) },
        arg("polyline"),
        (arg("mode", "walk") as "walk" | "drive"),
      );
      console.log(JSON.stringify(device, null, 2));
      break;
    }
    case "park": {
      console.log(JSON.stringify(await parkStationary(arg("imageId")), null, 2));
      break;
    }
    case "rpa": {
      await queueSearch(
        arg("imageId"),
        arg("templateId"),
        JSON.parse(arg("vars", "{}")) as Record<string, unknown>,
        arg("name", "local-search"),
      );
      console.log("queued");
      break;
    }
    default:
      console.log(`observatory CLI
  register --imageId= --lat= --lng= [--ssid=] [--bssid=] [--wigle=true] [--carrier=T-Mobile] [--days=30]
  list
  navigate --imageId= --destLat= --destLng= --polyline= [--mode=walk]
  park --imageId=
  rpa --imageId= --templateId= [--vars={}] [--name=local-search]
`);
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
