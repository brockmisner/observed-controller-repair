import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
// The app's SDK floor is 29. Java 11 Files.readString/writeString are not
// available at that floor without core-library desugaring (not enabled here).
test('Android config I/O avoids Java APIs above the supported SDK floor',()=>{
  for(const name of ['MainActivity','BridgeService']){
    const source=readFileSync(`android/environment-observer/app/src/main/java/net/stakeout/environment/${name}.java`,'utf8');
    assert.doesNotMatch(source,/Files\.(readString|writeString)\(/);
  }
});
test('lab APK excludes the platform observation implementation',()=>{
  const lab=readFileSync('android/environment-observer/app/src/lab/java/net/stakeout/environment/AndroidReadback.java','utf8');
  assert.doesNotMatch(lab,/android\.(location|telephony|bluetooth|net\.wifi)/);
  assert.ok(lab.includes('LAB_HAS_NO_READBACK'));
});
