import { prisma } from '../db.js';
import { listCloudPhoneGroups } from '../api/duoPlusClient.js';
import { logger } from '../logger.js';
import { folderInventory, readFolders, type Folder, type FolderInventory } from './folderData.js';
export async function savedFolders(tenantId?: string): Promise<FolderInventory | null> {
  if (!tenantId) return null;
  const row = await prisma.duoPlusFolderInventory.findUnique({ where: { tenantId } });
  return row ? JSON.parse(row.payloadJson) : null;
}
export async function syncFolders(tenantId: string, remote: unknown[]) {
  const previous = await savedFolders(tenantId);
  let catalog: Folder[] | null = null;
  if (!previous?.catalogCheckedAt || Date.now() - Date.parse(previous.catalogCheckedAt) > 300_000) {
    try {
      const found: Folder[] = [];
      let expected: number | undefined;
      for (let page = 1; page <= 100; page++) {
        const data = await listCloudPhoneGroups(page, tenantId) as { list?: unknown; total_page?: number };
        const parsed = readFolders(data?.list);
        const pages = data?.total_page;
        if (!parsed || !Number.isInteger(pages) || pages! < 0 || pages! > 100 ||
            expected !== undefined && pages !== expected || pages === 0 && parsed.length > 0 || pages! > 1 && !parsed.length) throw new Error('Invalid folder pagination');
        expected = pages;
        found.push(...parsed);
        if (page >= pages!) { catalog = readFolders(found); break; }
      }
    } catch { logger.warn({ tenantId }, 'Folder catalog unavailable; retaining saved catalog and using phone memberships'); }
  }
  const value = folderInventory(remote, catalog, previous ?? undefined);
  await prisma.duoPlusFolderInventory.upsert({ where: { tenantId },
    create: { tenantId, payloadJson: JSON.stringify(value), syncedAt: new Date(value.checkedAt) },
    update: { payloadJson: JSON.stringify(value), syncedAt: new Date(value.checkedAt) } });
  if (!previous || JSON.stringify(previous.folders) !== JSON.stringify(value.folders)) logger.info({ event: 'duoplus_folders', tenantId,
    folders: value.folders.map(f => ({ ...f, phones: value.phones.filter(p => p.groups?.some(g => g.id === f.id)).length })),
    inventoryPhones: value.phones.length }, 'DuoPlus folders synchronized');
}
