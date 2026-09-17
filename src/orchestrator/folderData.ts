export interface Folder { id: string; name: string }
export interface FolderPhone { imageId: string; name: string; status: number | null; groups: Folder[] | null }
export interface FolderInventory { folders: Folder[]; phones: FolderPhone[]; checkedAt: string; catalogCheckedAt?: string }
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 300 && !/[\x00-\x1f]/.test(value); }
export function readFolders(value: unknown): Folder[] | null {
  if (!Array.isArray(value)) return null;
  const result = new Map<string, Folder>();
  for (const entry of value) {
    if (!entry || !text(entry.id) || !text(entry.name)) return null;
    if (result.has(entry.id) && result.get(entry.id)!.name !== entry.name) return null;
    result.set(entry.id, { id: entry.id, name: entry.name });
  }
  return [...result.values()].sort((a,b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
// Only copy explicit, non-secret inventory fields. Missing membership is unknown, never ungrouped.
export function folderInventory(rows: unknown[], catalog: Folder[] | null, previous?: FolderInventory, now = new Date()): FolderInventory {
  const phones: FolderPhone[] = [];
  const ids = new Set<string>();
  for (const value of rows) {
    const row = value as Record<string, unknown>;
    const imageId = row?.id ?? row?.image_id;
    if (!text(imageId) || ids.has(imageId)) throw new Error('Invalid or duplicate phone ID in folder inventory');
    ids.add(imageId);
    phones.push({ imageId, name: text(row.name) ? row.name : imageId,
      status: typeof row.status === 'number' && Number.isInteger(row.status) ? row.status : null,
      groups: readFolders(row.group) });
  }
  const folders = new Map((catalog ?? previous?.folders ?? []).map(f => [f.id, f]));
  for (const phone of phones) for (const group of phone.groups ?? []) folders.set(group.id, group);
  return { folders: [...folders.values()].sort((a,b) => a.name.localeCompare(b.name)), phones,
    checkedAt: now.toISOString(), catalogCheckedAt: catalog ? now.toISOString() : previous?.catalogCheckedAt };
}
