import test from 'node:test';
import assert from 'node:assert/strict';
import { folderInventory, readFolders } from '../src/orchestrator/folderData.js';
test('preserves multiple real folder IDs, deduplicates membership, and includes expired phones', () => {
  const groups = [{ id:'a', name:'Miami' }, { id:'b', name:'Lakeland' }, { id:'a', name:'Miami' }];
  const result = folderInventory([{ id:'phone', status:3, group:groups, adb_password:'secret', proxy:{ password:'private' } }], [{ id:'c', name:'Empty' }]);
  assert.equal(result.phones[0]!.status,3);
  assert.equal(result.phones[0]!.groups!.length,2);
  assert.equal(result.folders.length,3);
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.ok(!JSON.stringify(result).includes('private'));
});
test('missing or malformed folder fields are unknown, explicit empty array is ungrouped', () => {
  const result = folderInventory([{ id:'a' }, { id:'b', group:[] }, { id:'c', group:[{id:'x'}] }], null);
  assert.equal(result.phones[0]!.groups,null);
  assert.deepEqual(result.phones[1]!.groups,[]);
  assert.equal(result.phones[2]!.groups,null);
});
test('updates renamed folders and moved membership without changing device assignment fields', () => {
  const previous = folderInventory([{id:'phone',group:[{id:'a',name:'Old'}]}], null);
  const updated = folderInventory([{id:'phone',group:[{id:'b',name:'New'}]}], [{id:'a',name:'Renamed'},{id:'b',name:'New'}], previous);
  assert.deepEqual(updated.phones[0]!.groups,[{id:'b',name:'New'}]);
  assert.equal(updated.folders.find(f=>f.id==='a')!.name,'Renamed');
  assert.ok(!('activeTripId' in updated.phones[0]!));
});
test('rejects ambiguous duplicate phones and conflicting folder names', () => {
  assert.throws(()=>folderInventory([{id:'a'},{id:'a'}],null));
  assert.equal(readFolders([{id:'a',name:'one'},{id:'a',name:'two'}]),null);
});
