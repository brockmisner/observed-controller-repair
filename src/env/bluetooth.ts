import { createHash, randomBytes } from "node:crypto";

const OUIS = ["3d:01:d7", "ac:de:48", "00:1a:7d", "b8:27:eb", "dc:a6:32"];
const NAMES = [
  "Pixel Buds",
  "Redmi K30",
  "Galaxy Buds2",
  "AirPods Pro",
  "JBL Flip 6",
  "Sony WH-1000XM4",
];

export function bluetoothProfile(imageId: string): { name: string; address: string } {
  const digest = createHash("sha256").update(`bt:${imageId}`).digest();
  const oui = OUIS[digest[0]! % OUIS.length]!;
  const rest = [...digest.subarray(1, 4)].map((b) => b.toString(16).padStart(2, "0")).join(":");
  return {
    name: NAMES[digest[4]! % NAMES.length]!,
    address: `${oui}:${rest}`,
  };
}

export function randomLocalMac(): string {
  const bytes = randomBytes(6);
  bytes[0] = (bytes[0]! & 0xfe) | 0x02;
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(":");
}
