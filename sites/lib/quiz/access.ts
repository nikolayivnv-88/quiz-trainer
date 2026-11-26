export const visitorCookie = 'quiz_trainer';
export type Access = { canManage: boolean };
export function accessFor(user: {email:string} | null, ownerEmail: unknown): Access {
  // Public sign-in establishes identity, not permission to administer this Site.
  return {canManage:typeof ownerEmail==='string'&&ownerEmail.length>0&&user?.email.toLowerCase()===ownerEmail.toLowerCase()};
}
export function visitorToken(request: Request): string {
  const value=request.headers.get('Cookie')?.split(';').map(v=>v.trim()).find(v=>v.startsWith(visitorCookie+'='))?.slice(visitorCookie.length+1)??'';
  return /^[a-f0-9]{64}$/.test(value)?value:'';
}
export function requireCsrf(request:Request) {
  const token=visitorToken(request);
  return !!token && request.headers.get('X-Quiz-CSRF')===token;
}
