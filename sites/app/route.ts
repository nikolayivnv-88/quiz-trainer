import shell from '../lib/quiz/shell.html?raw';
import { headers } from '../lib/quiz/http';
import { visitorCookie, visitorToken } from '../lib/quiz/access';
export const dynamic='force-dynamic';
export async function GET(request:Request){
  const token=visitorToken(request)||Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
  const secure=new URL(request.url).protocol==='https:'?'; Secure':'';
  return new Response(shell,{headers:{...headers,'Content-Type':'text/html; charset=utf-8','Set-Cookie':`${visitorCookie}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secure}`}});
}
