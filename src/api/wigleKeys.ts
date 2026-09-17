import axios from "axios";
import { z } from "zod";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { decryptSecret, encryptSecret, last4 } from "../security/crypto.js";

const credentialsSchema = z.object({
  apiName: z.string().trim().min(1).max(512).regex(/^[^\s:]+$/, "Invalid WiGLE API name"),
  apiToken: z.string().trim().min(1).max(1024).regex(/^\S+$/, "Invalid WiGLE API token"),
});

export type WigleCredentials = z.infer<typeof credentialsSchema>;

const metadataSelect = {
  tenantId: true,
  apiNameLast4: true,
  apiTokenLast4: true,
  lastValidatedAt: true,
  createdAt: true,
} as const;

function metadata(row: {
  tenantId: string;
  apiNameLast4: string;
  apiTokenLast4: string;
  lastValidatedAt: Date;
  createdAt: Date;
}) {
  return {
    id: row.tenantId,
    label: "WiGLE",
    last4: row.apiTokenLast4,
    apiName: `****${row.apiNameLast4}`,
    lastValidatedAt: row.lastValidatedAt,
    createdAt: row.createdAt,
  };
}

export async function getTenantWigleStatus(tenantId: string) {
  const row = await prisma.tenantWigleCredential.findUnique({
    where: { tenantId },
    select: metadataSelect,
  });
  return row ? metadata(row) : null;
}

export async function saveTenantWigleCredentials(tenantId: string, apiName: string, apiToken: string) {
  const credentials = credentialsSchema.parse({ apiName, apiToken });
  let response;
  try {
    response = await axios.get("https://api.wigle.net/api/v2/profile/user", {
      auth: { username: credentials.apiName, password: credentials.apiToken },
      headers: { Accept: "application/json" },
      timeout: 20_000,
      maxRedirects: 0,
      validateStatus: () => true,
    });
  } catch {
    // Axios errors contain the plaintext Basic Auth credentials in their config.
    throw new Error("WiGLE could not be reached. Try saving your credentials again later.");
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error("WiGLE authentication failed. Check your API name and API token.");
  }
  if (response.status === 429) {
    throw new Error("WiGLE rate limited credential validation. Try again later.");
  }
  if (response.status < 200 || response.status >= 300 ||
      ![true, "true"].includes(response.data?.success)) {
    throw new Error("WiGLE could not validate these credentials. Try again later.");
  }
  const sealed = encryptSecret(JSON.stringify(credentials));
  const data = {
    ...sealed,
    apiNameLast4: last4(credentials.apiName),
    apiTokenLast4: last4(credentials.apiToken),
    lastValidatedAt: new Date(),
  };
  const row = await prisma.tenantWigleCredential.upsert({
    where: { tenantId },
    create: { tenantId, ...data },
    update: data,
    select: metadataSelect,
  });
  return metadata(row);
}

export async function deleteTenantWigleCredentials(tenantId: string): Promise<void> {
  await prisma.tenantWigleCredential.deleteMany({ where: { tenantId } });
}

export async function getWigleCredentials(tenantId?: string): Promise<WigleCredentials | null> {
  if (tenantId) {
    const row = await prisma.tenantWigleCredential.findUnique({ where: { tenantId } });
    if (row) {
      return credentialsSchema.parse(JSON.parse(decryptSecret(row)));
    }
  }
  if (config.authRequired) return null;
  return config.wigleApiName && config.wigleApiToken
    ? { apiName: config.wigleApiName, apiToken: config.wigleApiToken }
    : null;
}
