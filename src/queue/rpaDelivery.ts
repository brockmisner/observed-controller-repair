import type { RpaJobData } from "../types.js";

export const pendingRpaStatuses = ["enqueue_pending", "queued"];
export const unresolvedRpaStatuses = [...pendingRpaStatuses, "submitting", "submitted", "unconfirmed"];

export interface RpaIntent {
  id: string; deviceId: string; templateId: string; templateType: number;
  name: string; variablesJson: string; status: string;
  device: { tenantId: string; imageId: string };
}
export interface RpaDeliveryDependencies {
  enqueue(data: RpaJobData): Promise<string>;
  markQueued(id: string): Promise<void>;
}

export async function deliverRpaIntent(intent: RpaIntent, deps: RpaDeliveryDependencies): Promise<"queued" | "pending"> {
  if (!pendingRpaStatuses.includes(intent.status)) throw new Error("RPA intent is no longer pending");
  try {
    const variables: unknown = JSON.parse(intent.variablesJson);
    if (!variables || typeof variables !== "object" || Array.isArray(variables)) throw new Error("Invalid saved RPA variables");
    if (intent.templateType !== 1 && intent.templateType !== 2) throw new Error("Invalid saved RPA template type");
    await deps.enqueue({ rpaJobId: intent.id, tenantId: intent.device.tenantId, deviceId: intent.deviceId,
      imageId: intent.device.imageId, templateId: intent.templateId, templateType: intent.templateType,
      name: intent.name, variables: variables as Record<string, unknown> });
    await deps.markQueued(intent.id);
    return "queued";
  } catch {
    // The persisted intent was accepted even if the Redis acknowledgment was
    // lost. Retrying its stable identity is safe; never ask callers to resubmit.
    return "pending";
  }
}
