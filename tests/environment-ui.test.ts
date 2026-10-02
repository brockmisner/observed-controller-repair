import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import{readFileSync}from'node:fs';
import {summarizeReport}from'../src/radio/environmentProtocol.js';import{report}from'./helpers/environmentFixture.js';
function ui(){const context={module:{exports:{} as any}};vm.runInNewContext(readFileSync('public/environment-observer.js','utf8'),context);return context.module.exports;}
test('observer UI escapes untrusted identifiers and labels test-only application',()=>{
 const r=report();r.imageId='<img src=x onerror=alert(1)>';const html=ui().markup({observation:summarizeReport(r,0),lab:{status:'STAGED_TEST_STATE'}});
 assert.ok(!html.includes('<img'));assert.ok(html.includes('&lt;img'));assert.ok(html.includes('Android radio application: not implemented'));assert.ok(html.includes('Mock flag'));assert.ok(html.includes('true'));
});
test('observer UI shows failed reads alongside previous evidence',()=>{const html=ui().markup({error:'OBSERVATION_FAILED'});assert.ok(html.includes('previous observation, not a new success'));assert.ok(html.includes('No independent observation'));});
