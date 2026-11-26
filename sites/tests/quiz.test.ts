import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { Miniflare } from 'miniflare';
import { Quiz,normalizeAnswer,checkAnswer,validateConfig,AppError } from '../lib/quiz/engine';
import { initialize,load,mutate } from '../lib/quiz/storage';
import { api } from '../lib/quiz/http';
import cases from './normalization.json' with {type:'json'};
import bank from './questions.json' with {type:'json'};

test('Python normalization and all curated answer variants stay compatible',()=>{
  for(const c of cases)assert.equal(normalizeAnswer(c.input),c.normalized,c.input);
  for(const q of bank)for(const a of [q.answer,...q.alternatives])assert(checkAnswer(q,a));
  for(const s of ['', '   ', '---'])assert(!checkAnswer(bank[0],s));
  assert.notEqual(normalizeAnswer('3.14'),normalizeAnswer('314'));
  assert.notEqual(normalizeAnswer('-2'),normalizeAnswer('2'));
});
test('invalid filters and counts are rejected',()=>{
  for(const config of [{mode:null},{categories:null},{difficulty:null},{mode:'topic',count:null},{mode:{}},{mode:'toString'},{categories:['__proto__']},{count:true,mode:'topic'},{difficulty:'unknown'},{categories:[]}])assert.throws(()=>validateConfig(config),AppError);
});
test('edits, deleted questions, historical acceptance and invalid media',()=>{
  const q=new Quiz(structuredClone(bank),[]),s=q.create({mode:'topic',count:1}),id=s.questions[0].id;
  q.act(s.id,{action:'next',revision:0,question_index:0,text:'исторически вариант'});
  const original=structuredClone(q.questions.find(b=>b.id===id)!);
  q.updateQuestion(id,{...original,prompt:original.prompt+' Променен въпрос.'});
  q.act(s.id,{action:'accept_answer',revision:1,index:0});
  assert.equal(s.answers[0].correct,true);assert.equal(s.answers[0].variant_saved,false);
  assert(!checkAnswer(q.questions.find(b=>b.id===id)!,'исторически вариант'));
  assert.throws(()=>q.updateQuestion(id,{...original,image:{path:'__proto__'}}),AppError);
  assert.throws(()=>q.updateQuestion(id,{...original,alternatives:null}),AppError);
  q.deleteQuestion(id);assert.equal(s.questions[0].prompt,original.prompt);
  q.deleteSession(s.id);assert.equal(q.summary().sessions.length,0);
});
test('51 questions, six rounds, retries, visual selection and acceptance',()=>{
  const q=new Quiz(structuredClone(bank),[]),s=q.create({mode:'full'});
  assert.equal(new Set(s.questions.map(q=>q.id)).size,51);assert(s.questions.some(q=>q.image));
  while(s.status!=='completed'){
    if(s.status==='review')q.act(s.id,{action:'next_round',revision:s.revision});
    else q.act(s.id,{action:'next',revision:s.revision,question_index:s.index,text:s.questions[s.index].answer});
  }
  assert.equal(q.summary().sessions[0].correct,51);assert.equal(q.summary().stats.missed,0);
  const wrong=q.create({mode:'topic',count:1});
  q.act(wrong.id,{action:'next',revision:0,question_index:0,text:'нов допустим вариант'});
  assert(q.summary().missed_ids.includes(wrong.questions[0].id));
  assert.throws(()=>q.act(wrong.id,{action:'accept_answer',revision:0,index:0}),/друг прозорец/);
  q.act(wrong.id,{action:'accept_answer',revision:1,index:0});
  assert(checkAnswer(q.questions.find(b=>b.id===wrong.questions[0].id)!,'нов допустим вариант'));
  assert(!q.summary().missed_ids.includes(wrong.questions[0].id));
});
test('D1 persistence, transaction rollback, racing writers, import once and HTTP guards',async()=>{
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-05-15',d1Databases:['DB'],cf:false});
  try{
    const db=await mf.getD1Database('DB') as unknown as D1Database;
    const sql=readFileSync('drizzle/0000_tiny_morbius.sql','utf8');
    for(const s of sql.split('--> statement-breakpoint'))if(s.trim())await db.prepare(s.trim()).run();
    const encoded=gzipSync(JSON.stringify({questions:bank,sessions:[]})).toString('base64');
    const env={QUIZ_IMPORT_0:encoded};await initialize(db,env);
    const session=await mutate(db,q=>q.create({mode:'topic',count:1})) as any;
    await mutate(db,q=>q.act(session.id,{action:'next',revision:0,question_index:0,text:'нов вариант'}));
    const racing=await Promise.allSettled([mutate(db,q=>q.act(session.id,{action:'accept_answer',revision:1,index:0})),mutate(db,q=>q.act(session.id,{action:'accept_answer',revision:1,index:0}))]);
    assert.equal(racing.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(racing.filter(x=>x.status==='rejected').length,1);
    let state=await load(db);assert.equal(state.quiz.session(session.id).revision,2);
    const target=state.quiz.session(session.id).questions[0].id;
    assert(checkAnswer(state.quiz.questions.find(q=>q.id===target)!,'нов вариант'));
    const before=JSON.stringify(state.quiz.questions);
    // Simulate a competing commit after loading, before our write batch.
    const wrapped={batch:async(statements:any[])=>{
      if(statements.length>3)await db.prepare('UPDATE quiz_meta SET revision=revision+1 WHERE id=1').run();
      return db.batch(statements);
    },prepare:db.prepare.bind(db)} as unknown as D1Database;
    await assert.rejects(mutate(wrapped,q=>{q.questions[0].answer='should roll back';return true;}),/друг прозорец/);
    assert.equal(JSON.stringify((await load(db)).quiz.questions),before);
    await mutate(db,q=>q.deleteQuestion(target));await initialize(db,env);
    state=await load(db);assert(!state.quiz.questions.some(q=>q.id===target));
    assert.equal(state.quiz.session(session.id).answers[0].correct,true);
    const request=(method:string,body:any,headers:Record<string,string>={})=>new Request('https://quiz.test/api/sessions',{method,headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
    assert.equal((await api(request('POST',{}, {Origin:'https://evil.test'}),db,env)).status,403);
    assert.equal((await api(request('POST',{}, {'Content-Type':'text/plain'}),db,env)).status,415);
    assert.equal((await api(request('POST',{mode:'topic',count:1}),db,env)).status,201);
    assert.equal((await api(new Request('https://quiz.test/data/quiz.sqlite3'),db,env)).status,404);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM quiz_guard').first<any>())!.n,0);
  }finally{await mf.dispose();}
});
