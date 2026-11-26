import { AppError, fold, type RecordValue } from './engine';
import { initialize, load, mutate } from './storage';
import { requireCsrf, visitorToken, type Access } from './access';
export const headers={
  'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
export async function api(request:Request,db:D1Database,env:Record<string,unknown>,access:Access={canManage:false}) {
  const json=(data:unknown,status=200)=>Response.json(data,{status,headers});
  try{
    const url=new URL(request.url),path=url.pathname,method=request.method;
    const origin=request.headers.get('Origin');
    if((origin&&origin!==url.origin)||request.headers.get('Sec-Fetch-Site')==='cross-site')throw new AppError('Неразрешена външна заявка.',403);
    if(!['GET','DELETE'].includes(method)&&request.headers.get('Content-Type')?.split(';')[0]!=='application/json')throw new AppError('Изисква се application/json.',415);
    if(method!=='GET'&&!requireCsrf(request))throw new AppError('Презаредете страницата, за да запазите отговора.',403);
    await initialize(db,env);
    if(method==='GET'){
      const {quiz}=await load(db);
      if(path==='/api/bootstrap')return json({...quiz.summary(),permissions:{can_manage:access.canManage},csrf_token:visitorToken(request)});
      if(path==='/api/questions'){
        let questions=quiz.questions;
        for(const key of ['category','difficulty']){const v=url.searchParams.get(key);if(v)questions=questions.filter(q=>q[key]===v);}
        const query=fold(url.searchParams.get('q')??'').trim();if(query)questions=questions.filter(q=>fold(q.prompt).includes(query)||fold(q.answer).includes(query));
        return json({questions});
      }
      if(/^\/api\/sessions\/[a-f0-9]{32}$/.test(path))return json(quiz.session(path.split('/')[3]));
    }
    let body:RecordValue={};
    if(!['GET','DELETE'].includes(method)){
      const text=await request.text();if(new TextEncoder().encode(text).length>1_000_000)throw new AppError('Невалиден размер на заявката.');
      try{body=JSON.parse(text);}catch{throw new AppError('Невалиден JSON.');}
      if(!body||typeof body!=='object'||Array.isArray(body))throw new AppError('Невалиден JSON.');
    }
    if(method==='POST'&&path==='/api/sessions')return json(await mutate(db,q=>q.create(body)),201);
    if(/^\/api\/sessions\/[a-f0-9]{32}$/.test(path)){
      const id=path.split('/')[3];
      if(method==='PATCH'){
        if(body.action==='accept_answer'&&!access.canManage)throw new AppError('Само собственикът може да приема нови варианти на отговорите.',403);
        return json(await mutate(db,q=>q.act(id,body)));
      }
      if(method==='DELETE'){
        if(!access.canManage)throw new AppError('Само собственикът може да изтрива историята.',403);
        return json(await mutate(db,q=>q.deleteSession(id)));
      }
    }
    if(/^\/api\/questions\/[a-z0-9-]+$/.test(path)){
      const id=path.split('/')[3];
      if((method==='PUT'||method==='DELETE')&&!access.canManage)throw new AppError('Само собственикът може да променя банката с въпроси.',403);
      if(method==='PUT')return json(await mutate(db,q=>q.updateQuestion(id,body)));
      if(method==='DELETE')return json(await mutate(db,q=>q.deleteQuestion(id)));
    }
    throw new AppError('Адресът не е намерен.',404);
  }catch(error){return error instanceof AppError?json({error:error.message},error.status):json({error:'Възникна неочаквана грешка. Презаредете страницата; запазените данни остават налични.'},500);}
}
