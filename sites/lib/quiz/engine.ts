import config from './config.json' with { type: 'json' };
import casefold from './casefold.json' with { type: 'json' };
import { createHash } from 'node:crypto';

export type RecordValue = Record<string, any>;
export class AppError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
const fail = (message: string, status = 400): never => { throw new AppError(message, status); };
const stamp = () => new Date().toISOString();
const clone = <T>(v: T): T => structuredClone(v);
export function fold(text: string) {
  return Array.from(text.normalize('NFKC'),c=>(casefold as Record<string,string>)[c]??c.toLowerCase()).join('');
}
export function normalizeAnswer(text: string) {
  text = fold(text).trim().replace(/(?<=\d),(?=\d)/g, '.').replace(/(?<=\p{L})[-‐‑–—](?=\p{L})/gu, ' ');
  return Array.from(text).map((c,i,a) => /[\p{L}\p{N}\s]/u.test(c) ||
    (c === '.' && /\d/.test(a[i-1] || '') && /\d/.test(a[i+1] || '')) ||
    ('+-−'.includes(c) && /\d/.test(a[i+1] || '')) ? c : ' ').join('').replace(/−/g,'-').trim().replace(/\s+/gu,' ');
}
export function checkAnswer(q: RecordValue, text: string) {
  const n = normalizeAnswer(text);
  return !!n && [q.answer,...q.alternatives].some(v => normalizeAnswer(v) === n);
}
function string(v: unknown, name: string, max=2000, required=true): string {
  if (typeof v !== 'string' || Array.from(v).length > max || (required && !v.trim())) fail(`Невалидно поле: ${name}.`);
  return (v as string).trim();
}
export function validateConfig(v: RecordValue) {
  const mode=v.mode===undefined?'quick':v.mode, categories=v.categories===undefined?Object.keys(config.categories):v.categories, difficulty=v.difficulty===undefined?'mixed':v.difficulty;
  if (typeof mode!=='string'||!Object.hasOwn(config.modes,mode)) fail('Невалиден режим.');
  if (!Array.isArray(categories) || !categories.length || categories.some(c=>typeof c!=='string'||!Object.hasOwn(config.categories,c))) fail('Изберете поне една категория.');
  if (typeof difficulty!=='string'||!['mixed',...Object.keys(config.difficulties)].includes(difficulty)) fail('Невалидна трудност.');
  const count=mode==='full'?51:mode==='quick'?10:v.count===undefined?10:v.count;
  if (!Number.isInteger(count)||count<1||count>51) fail('Броят въпроси трябва да е между 1 и 51.');
  return {mode,categories:[...new Set<string>(categories)],difficulty,count};
}
export function brief(s: RecordValue) {
  return {...Object.fromEntries(['id','name','mode','status','created_at','updated_at','index'].map(k=>[k,s[k]])),count:s.answers.length,graded:s.answers.filter((a:RecordValue)=>a.correct!==null).length,correct:s.answers.filter((a:RecordValue)=>a.correct===true).length};
}
export class Quiz {
  constructor(public questions: RecordValue[], public sessions: RecordValue[]) {}
  session(id: string) { return this.sessions.find(s=>s.id===id) ?? fail('Играта не е намерена.',404); }
  latest() {
    const latest=new Map<string,{date:string,correct:boolean}>();
    for (const s of this.sessions) s.questions.forEach((q:RecordValue,i:number)=>{
      const a=s.answers[i], date=a.graded_at??s.updated_at;
      if (a.correct!==null&&(!latest.has(q.id)||date>latest.get(q.id)!.date)) latest.set(q.id,{date,correct:a.correct});
    });
    return latest;
  }
  summary() {
    const categories:RecordValue=Object.fromEntries(Object.keys(config.categories).map(c=>[c,{total:0,correct:0}]));
    for (const s of this.sessions) s.questions.forEach((q:RecordValue,i:number)=>{
      const a=s.answers[i];if(a.correct!==null){categories[q.category].total++;categories[q.category].correct+=Number(a.correct);}
    });
    const latest=this.latest(), missed=this.questions.filter(q=>latest.get(q.id)?.correct===false).map(q=>q.id);
    return {categories:config.categories,difficulties:config.difficulties,modes:config.modes,stats:{bank:this.questions.length,visual:this.questions.filter(q=>q.image).length,completed:this.sessions.filter(s=>s.status==='completed').length,missed:missed.length,categories},missed_ids:missed,sessions:[...this.sessions].sort((a,b)=>b.updated_at.localeCompare(a.updated_at)).map(brief)};
  }
  create(v: RecordValue) {
    const c=validateConfig(v), latest=this.latest();
    const available=this.questions.filter(q=>c.categories.includes(q.category)&&(c.difficulty==='mixed'||q.difficulty===c.difficulty)&&(c.mode!=='retry'||latest.get(q.id)?.correct===false));
    const required=c.mode==='retry'?Math.min(c.count,available.length):c.count;
    if(!required||available.length<required) fail(`Налични са ${available.length} въпроса за този избор, а са нужни ${c.count}. Променете филтрите или намалете броя.`);
    const shuffle=<T>(a:T[])=>{for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;};
    const groups=new Map<string,RecordValue[]>();
    for(const q of shuffle([...available])){if(!groups.has(q.category))groups.set(q.category,[]);groups.get(q.category)!.push(q);}
    const chosen:RecordValue[]=[];
    while(chosen.length<required) for(const key of shuffle([...groups.keys()])) {const group=groups.get(key)!;chosen.push(group.pop()!);if(!group.length)groups.delete(key);if(chosen.length===required)break;}
    if(!chosen.some(q=>q.image)){const visual=shuffle(available.filter(q=>q.image&&chosen.some(c=>c.category===q.category)))[0];if(visual)chosen[chosen.findIndex(q=>q.category===visual.category)]=visual;}
    const now=stamp(), s={id:crypto.randomUUID().replaceAll('-',''),mode:c.mode,name:(config.modes as RecordValue)[c.mode],status:'playing',index:0,round_size:10,revision:0,created_at:now,updated_at:now,questions:clone(chosen),answers:chosen.map(()=>({text:'',correct:null}))};
    this.sessions.push(s);return s;
  }
  act(id:string,v:RecordValue) {
    const s=this.session(id);
    if(v.revision!==s.revision) fail('Играта е променена в друг прозорец. Презаредете, за да продължите.',409);
    const i=s.index, start=Math.floor(i/10)*10,end=Math.min(start+10,s.questions.length), action=v.action;
    if(action==='save_answer'||action==='next') {
      if(s.status!=='playing')fail('Този кръг вече е предаден.');
      if(v.question_index!==i)fail('Този въпрос вече е предаден. Презаредете играта, за да продължите.',409);
      const a=s.answers[i];a.text=string(v.text===undefined?'':v.text,'вашият отговор',2000,false);
      if(action==='next'){a.correct=checkAnswer(s.questions[i],a.text);a.graded_at=stamp();if(i+1===end)s.status='review';else s.index++;}
    } else if(action==='next_round') {
      if(s.status!=='review')fail('Първо предайте кръга.');
      if(end===s.questions.length)s.status='completed';else{s.status='playing';s.index=end;}
    } else if(action==='accept_answer') {
      const t=v.index;
      if(!['review','completed'].includes(s.status)||!Number.isInteger(t)||t<0||t>=s.answers.length||(s.status==='review'&&(t<start||t>=end)))fail('Можете да приемете отговор само в ревюто.');
      const a=s.answers[t],q=s.questions[t];
      if(a.correct!==false)fail('Този отговор вече е отчетен като верен.',409);
      const text=string(a.text,'подаденият отговор');if(!normalizeAnswer(text))fail('Няма подаден отговор за приемане.');
      const bank=this.questions.find(b=>b.id===q.id);let learned=false;
      if(bank&&bank.prompt===q.prompt&&bank.answer===q.answer&&JSON.stringify(bank.image)===JSON.stringify(q.image)){
        if(!checkAnswer(bank,text)){bank.alternatives.push(text);bank.updated_at=stamp();}learned=true;
      }
      if(!checkAnswer(q,text))q.alternatives.push(text);
      Object.assign(a,{correct:true,graded_at:stamp(),accepted_at:stamp(),variant_saved:learned});
    } else fail('Непознато действие.');
    s.revision++;s.updated_at=stamp();return s;
  }
  updateQuestion(id:string,v:RecordValue) {
    const q=this.questions.find(q=>q.id===id)??fail('Въпросът не е намерен.',404);
    const fields:RecordValue={prompt:string(v.prompt,'въпрос',1500),answer:string(v.answer,'отговор',500),explanation:string(v.explanation,'обяснение',2000)};
    for(const [key,choices] of Object.entries({category:config.categories,difficulty:config.difficulties})){
      if(typeof v[key]!=='string'||!Object.hasOwn(choices,v[key]))fail(`Невалидно поле: ${key}.`);fields[key]=v[key];
    }
    const variants=v.alternatives===undefined?[]:v.alternatives;
    if(!Array.isArray(variants)||variants.length>15)fail('Допустимите варианти трябва да са списък до 15 отговора.');
    fields.alternatives=variants.map((a:unknown)=>string(a,'вариант',500));
    fields.image=null;
    if(v.image!=null){if(typeof v.image!=='object'||typeof v.image.path!=='string'||!Object.hasOwn(config.media,v.image.path))fail('Невалидно изображение.');const media=(config.media as RecordValue)[v.image.path];fields.image=Object.fromEntries(['path','credit','license','source_url','license_url','changes'].map(k=>[k,media[k]]));}
    const fingerprint=(s:string)=>fold(s).replace(/[^\p{L}\p{N}]/gu,'');
    if(this.questions.some(other=>other.id!==id&&fingerprint(other.prompt)===fingerprint(fields.prompt)))fail('Вече има въпрос със същото условие.',409);
    const changed=Object.keys(fields).some(k=>JSON.stringify(q[k])!==JSON.stringify(fields[k]));
    Object.assign(q,fields,{fingerprint:createHash('sha256').update(fingerprint(fields.prompt)).digest('hex'),source_url:changed?null:q.source_url,updated_at:stamp()});return {ok:true};
  }
  deleteQuestion(id:string) {const n=this.questions.length;this.questions=this.questions.filter(q=>q.id!==id);if(n===this.questions.length)fail('Въпросът не е намерен.',404);return {ok:true};}
  deleteSession(id:string) {this.session(id);this.sessions=this.sessions.filter(s=>s.id!==id);return {ok:true};}
}
