import { AppError, Quiz, type RecordValue } from './engine';

export async function initialize(db:D1Database, env:Record<string,unknown>) {
  const row=await db.prepare('SELECT imported FROM quiz_meta WHERE id=1').first<{imported:number}>();
  if(row?.imported)return;
  let encoded='';for(let i=0;typeof env['QUIZ_IMPORT_'+i]==='string';i++)encoded+=env['QUIZ_IMPORT_'+i];
  if(!encoded)throw new AppError('Базата още не е инициализирана.',503);
  const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
  const raw=await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  const snapshot=JSON.parse(raw);
  // Every statement is in one transaction; concurrent first requests cannot reseed.
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO quiz_meta(id,revision,imported) VALUES(1,0,0)'),
    db.prepare("INSERT INTO quiz_questions(id,state) SELECT json_extract(value,'$.id'),value FROM json_each(?) WHERE (SELECT imported FROM quiz_meta WHERE id=1)=0").bind(JSON.stringify(snapshot.questions)),
    db.prepare("INSERT INTO quiz_sessions(id,state) SELECT json_extract(value,'$.id'),value FROM json_each(?) WHERE (SELECT imported FROM quiz_meta WHERE id=1)=0").bind(JSON.stringify(snapshot.sessions)),
    db.prepare('UPDATE quiz_meta SET imported=1 WHERE id=1 AND imported=0'),
  ]);
}
export async function load(db:D1Database) {
  const [q,s,m]=await db.batch([
    db.prepare('SELECT state FROM quiz_questions ORDER BY json_extract(state,\'$.created_at\') DESC,id'),
    db.prepare('SELECT state FROM quiz_sessions ORDER BY json_extract(state,\'$.updated_at\') DESC,id'),
    db.prepare('SELECT revision FROM quiz_meta WHERE id=1'),
  ]);
  const parse=(r:D1Result)=>r.results.map(x=>JSON.parse((x as RecordValue).state));
  return {quiz:new Quiz(parse(q),parse(s)),revision:Number((m.results[0] as RecordValue).revision)};
}
export async function mutate(db:D1Database, action:(q:Quiz)=>unknown) {
  const {quiz,revision}=await load(db);
  const before=[quiz.questions,quiz.sessions].map(items=>new Map(items.map(i=>[i.id,JSON.stringify(i)])));
  const value=action(quiz);
  const batch=[db.prepare('INSERT INTO quiz_guard(id,accepted) VALUES(1,CASE WHEN (SELECT revision FROM quiz_meta WHERE id=1)=? THEN 1 ELSE 0 END)').bind(revision)];
  for(const [i,table] of ['quiz_questions','quiz_sessions'].entries()) {
    const rows=i===0?quiz.questions:quiz.sessions;
    for(const row of rows){const encoded=JSON.stringify(row);if(before[i].get(row.id)!==encoded)batch.push(db.prepare(`INSERT INTO ${table}(id,state) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state`).bind(row.id,encoded));before[i].delete(row.id);}
    for(const id of before[i].keys())batch.push(db.prepare(`DELETE FROM ${table} WHERE id=?`).bind(id));
  }
  batch.push(db.prepare('UPDATE quiz_meta SET revision=revision+1 WHERE id=1'),db.prepare('DELETE FROM quiz_guard WHERE id=1'));
  try {await db.batch(batch);}catch(e){if(String(e).includes('quiz_guard_accepted'))throw new AppError('Данните са променени в друг прозорец. Презаредете и опитайте отново.',409);throw e;}
  return value;
}
