import shell from '../lib/quiz/shell.html?raw';
import { getChatGPTUser, chatGPTSignInPath } from './chatgpt-auth';
import { headers } from '../lib/quiz/http';
export const dynamic='force-dynamic';
export async function GET(request:Request){
  if(!await getChatGPTUser())return Response.redirect(new URL(chatGPTSignInPath('/'),request.url));
  return new Response(shell,{headers:{...headers,'Content-Type':'text/html; charset=utf-8'}});
}
