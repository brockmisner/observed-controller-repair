interface Failure {
  imageId: string; signature: string; attempts: number; error: string;
  lastAttemptAt: number; nextRetryAt: number;
}

// Process-local diagnostics/cooldowns, never a source of device truth. Restart permits a fresh attempt.
export class ImportBackoff {
  private readonly tenants = new Map<string, Map<string, Failure>>();
  async run<T>(tenantId: string, imageId: string, signature: string, work: () => Promise<T>,
    describeFailure: (error: unknown) => string): Promise<T> {
    try {
      const result = await work();
      // A provider read is only one step; clear history after all persistence succeeds.
      this.clear(tenantId, imageId);
      return result;
    } catch (error) {
      this.fail(tenantId, imageId, signature, describeFailure(error));
      throw error;
    }
  }
  canAttempt(tenantId: string, imageId: string, signature: string, now = Date.now()): boolean {
    const failure = this.tenants.get(tenantId)?.get(imageId);
    if (failure && failure.signature !== signature) { this.clear(tenantId, imageId); return true; }
    return !failure || now >= failure.nextRetryAt;
  }
  fail(tenantId: string, imageId: string, signature: string, error: string, now = Date.now()): void {
    const entries = this.tenants.get(tenantId) ?? new Map<string, Failure>();
    const previous = entries.get(imageId);
    const attempts = previous?.signature === signature ? previous.attempts + 1 : 1;
    entries.set(imageId, { imageId, signature, attempts, error: error.slice(0, 500), lastAttemptAt: now,
      nextRetryAt: now + Math.min(30 * 60_000, 120_000 * 2 ** Math.min(attempts - 1, 4)) });
    if (entries.size > 2000) entries.delete(entries.keys().next().value!);
    this.tenants.set(tenantId, entries);
    if (this.tenants.size > 1000) this.tenants.delete(this.tenants.keys().next().value!);
  }
  clear(tenantId: string, imageId: string): void {
    const entries = this.tenants.get(tenantId);
    entries?.delete(imageId);
    if (!entries?.size) this.tenants.delete(tenantId);
  }
  prune(tenantId: string, imageIds: Set<string>): void {
    for (const id of this.tenants.get(tenantId)?.keys() ?? []) if (!imageIds.has(id)) this.clear(tenantId, id);
  }
  statuses(tenantId: string) {
    return [...(this.tenants.get(tenantId)?.values() ?? [])].map(({ signature: _signature, ...row }) => ({ ...row,
      lastAttemptAt: new Date(row.lastAttemptAt).toISOString(), nextRetryAt: new Date(row.nextRetryAt).toISOString() }));
  }
}
export const inventoryImportBackoff = new ImportBackoff();
