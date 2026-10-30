// Destructive only to its OWN child process; refuses existing configuration/database.
// Run in a disposable clean checkout after npm ci/build, never an operational checkout.
import {existsSync} from 'node:fs';
import {readFile,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import net from 'node:net';
import assert from 'node:assert/strict';
if(process.env.EXAMOS_BOOTSTRAP_TEST!=='isolated-clean-checkout' || existsSync('.env') || existsSync('data/postgres'))
  throw Error('Bootstrap test requires explicit opt-in in a clean disposable checkout with no .env/database');
const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));
const port=listener.address().port;await new Promise(r=>listener.close(r));
await writeFile('.env',`EXAMOS_LOCAL_DB=1\nHOST=127.0.0.1\nPORT=${port}\nJWT_SECRET=${randomBytes(48).toString('hex')}\n`,{flag:'wx'});
const setup=spawn(process.execPath,['scripts/setup-local.mjs'],{windowsHide:true,stdio:'ignore'});
assert.equal(await new Promise(r=>setup.once('exit',r)),0,'Clean database bootstrap failed');
const login=await readFile('data/initial-login.txt','utf8');
const email=/^Email: (.+)$/m.exec(login)[1], password=/^Password: (.+)$/m.exec(login)[1];
const base=`http://127.0.0.1:${port}`;
let child;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function start(){
  child=spawn(process.execPath,['server/index.js'],{windowsHide:true,stdio:'ignore'});
  for(let i=0;i<200;i++){
    try{if((await fetch(base+'/api/health')).ok)return}catch{}
    if(child.exitCode!==null)throw Error('Isolated server exited before readiness');
    await pause(100);
  }
  throw Error('Isolated startup timed out');
}
async function stop(){
  if(child && child.exitCode===null){const closed=new Promise(r=>child.once('exit',r));child.kill();await closed;}
}
async function request(path,body,token){
  return fetch(base+'/api'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});
}
try{
  await start();
  assert.equal((await request('/state')).status,401);
  const first=await request('/login',{email,password});assert.equal(first.status,200);
  const token=(await first.json()).token;
  const session=(await (await request('/sessions',{name:'Isolated restart acceptance'},token)).json()).id;
  assert.ok(session);
  await stop();await start();
  const second=await request('/login',{email,password});assert.equal(second.status,200,'Restart must preserve the actual generated account');
  const state=await (await request('/state',null,(await second.json()).token)).json();
  assert.equal(state.sessions.find(s=>s.id===session)?.status,'ended','Actual backend process restart must end the old session and preserve its history');
  console.log('PASS: clean bootstrap/login, unauthorized rejection, actual backend process restart, preserved account/history, and ended prior session. No native capture claim.');
}finally{await stop()}
