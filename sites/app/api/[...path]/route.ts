import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../../chatgpt-auth';
import { api, headers } from '../../../lib/quiz/http';
import { initialize, load } from '../../../lib/quiz/storage';
export const dynamic='force-dynamic';
async function handle(request:Request){
  if(new URL(request.url).pathname==='/api/_maintenance/import'){
    const vars=env as unknown as Record<string,unknown>;
    // An ephemeral random secret plus the platform's owner-private gate protects
    // the one-off migration verifier. Removing the secret disables this route.
    const key=vars.QUIZ_MAINTENANCE_KEY;
    if(typeof key!=='string'||request.headers.get('X-Quiz-Maintenance')!==key)return new Response(null,{status:404});
    if(request.method!=='POST'||!env.DB)return new Response(null,{status:405});
    await initialize(env.DB,vars);
    const {quiz}=await load(env.DB);
    const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
    const compare=(a:any,b:any)=>a.id<b.id?-1:a.id>b.id?1:0;
    const payload=canonical({questions:quiz.questions.sort(compare),sessions:quiz.sessions.sort(compare)});
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(payload)))),b=>b.toString(16).padStart(2,'0')).join('');
    return Response.json({questions:quiz.questions.length,sessions:quiz.sessions.length,digest},{headers});
  }
  if(!await getChatGPTUser())return Response.json({error:'Влезте с вашия ChatGPT профил.'},{status:401,headers});
  if(!env.DB)return Response.json({error:'Базата не е достъпна.'},{status:503,headers});
  return api(request,env.DB,env as unknown as Record<string,unknown>);
}
export {handle as GET,handle as POST,handle as PATCH,handle as PUT,handle as DELETE};
