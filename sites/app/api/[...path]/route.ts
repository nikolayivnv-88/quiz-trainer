import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../../chatgpt-auth';
import { api, headers } from '../../../lib/quiz/http';
import { accessFor } from '../../../lib/quiz/access';
export const dynamic='force-dynamic';
async function handle(request:Request){
  if(!env.DB)return Response.json({error:'Базата не е достъпна.'},{status:503,headers});
  const vars=env as unknown as Record<string,unknown>;
  return api(request,env.DB,vars,accessFor(await getChatGPTUser(),vars.QUIZ_OWNER_EMAIL));
}
export {handle as GET,handle as POST,handle as PATCH,handle as PUT,handle as DELETE};
