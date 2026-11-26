const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function theme(saved, systemDark, blocked = false) {
  const listeners = {};
  const button = {setAttribute(k,v){this[k]=v;},addEventListener(k,fn){listeners[k]=fn;}};
  const root = {dataset:{}};
  const storage = {getItem(){if(blocked)throw Error();return saved;},setItem(k,v){if(blocked)throw Error();saved=v;}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../static/theme.js'),'utf8'), {
    window:{matchMedia:()=>({matches:systemDark,addEventListener(){}})},localStorage:storage,
    document:{documentElement:root,getElementById:()=>button,addEventListener(k,fn){fn();}}
  });
  return {root,button,click:()=>listeners.click(),saved:()=>saved};
}
test('theme follows system initially, persists toggle, and restores explicit preference',()=>{
  const t=theme(null,true);
  assert.equal(t.root.dataset.theme,'dark');
  assert.equal(t.button['aria-pressed'],'true');
  t.click();
  assert.equal(t.root.dataset.theme,'light');
  assert.equal(t.saved(),'light');
  assert.equal(theme(t.saved(),true).root.dataset.theme,'light');
});
test('theme remains usable when storage is blocked',()=>{
  const t=theme(null,false,true);
  t.click();
  assert.equal(t.root.dataset.theme,'dark');
  assert.equal(t.button.textContent,'Светъл режим');
});
