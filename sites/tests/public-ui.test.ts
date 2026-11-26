import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext,runInContext } from 'node:vm';

function fixture(canManage:boolean){
  const nodes=new Map<string,any>();
  const node=(selector:string)=>{if(!nodes.has(selector))nodes.set(selector,{innerHTML:'',textContent:'',value:'',classList:{toggle(){}},setAttribute(){}});return nodes.get(selector);};
  const context=createContext({URL,Intl,Date,console,setTimeout:()=>1,clearTimeout(){},document:{querySelector:node,querySelectorAll:()=>[],addEventListener(){}},window:{addEventListener(){}},location:{hash:'#/'}});
  runInContext(readFileSync('public/app.js','utf8').replace(/\nboot\(\);\s*$/,''),context);
  const ui=runInContext('({state,libraryResults,history,reviewItem,api})',context);
  ui.state.data={permissions:{can_manage:canManage},csrf_token:'a'.repeat(64),categories:{history:'История'},difficulties:{medium:'Средно'},stats:{completed:0,categories:{}},sessions:[{id:'a'.repeat(32),name:'Тренировка',created_at:new Date().toISOString(),status:'completed',correct:0,graded:1}]};
  ui.state.questions=[{id:'q1',prompt:'Въпрос',answer:'Отговор',alternatives:[],category:'history',difficulty:'medium',explanation:'Обяснение'}];
  return {ui,node,context};
}
test('visitors can read questions and history but management controls are owner-only',()=>{
  for(const admin of [false,true]){
    const {ui,node}=fixture(admin);ui.libraryResults();
    assert.equal(node('#library-results').innerHTML.includes('data-action="edit"'),admin);
    assert.equal(node('#library-results').innerHTML.includes('data-action="delete-question"'),admin);
    ui.history();assert.equal(node('#main').innerHTML.includes('data-action="delete-session"'),admin);
    assert.equal(ui.reviewItem(ui.state.questions[0],{text:'Wrong',correct:false},0).includes('data-action="accept-answer"'),admin);
  }
});
test('answer writes include the browser CSRF token',async()=>{
  const {ui,context}=fixture(false);let sent:any;
  context.fetch=async(_url:string,options:any)=>{sent=options;return {ok:true,json:async()=>({ok:true})};};
  await ui.api('/api/sessions','POST',{mode:'topic'});
  assert.equal(sent.headers['X-Quiz-CSRF'],'a'.repeat(64));
});
