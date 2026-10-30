import {test} from 'node:test';
import assert from 'node:assert/strict';
import {io} from 'socket.io-client';
import {fixture,actualPaper,uploadForm} from './exam-fixture.mjs';
import {randomUUID} from 'node:crypto';

test('replacement/disconnect during an awaited sample cannot publish stale pixels or inherit consent',async()=>{
  const f=await fixture(), clients=[];
  const connect=async(auth)=>{
    const s=io(f.base,{auth,reconnection:false,transports:['websocket']});clients.push(s);
    await new Promise((resolve,reject)=>{s.once('connect',resolve);s.once('connect_error',reject)});return s;
  };
  const call=(s,n,p)=>s.timeout(3000).emitWithAck(n,p);
  try{
    const sid=(await f.request('/sessions',{name:'Isolated connection race'},f.token)).data.id;
    const d=await f.enroll('Protocol fixture, no native capture');
    const teacher=await connect({role:'teacher',token:f.token});
    const first=await connect({token:d.token});
    assert.equal((await call(first,'heartbeat',{})).screenConsented,false);
    await call(first,'consent',{sessionId:sid,accept:true});
    const previews=[];teacher.on('preview',p=>previews.push(p));
    let unblock,entered;
    const held=new Promise(r=>unblock=r), ready=new Promise(r=>entered=r);
    const query=f.db.query.bind(f.db);
    f.db.query=async(sql,args)=>{
      const result=await query(sql,args);
      if(sql.startsWith('INSERT INTO events') && args?.[4]==='telemetry_unavailable'){
        entered();await held;
      }
      return result;
    };
    // Explicit protocol codec marker; never asserted to be a webcam/screen photograph.
    first.emit('sample',{sessionId:sid,app:'[unavailable]',jpeg:'/9j/cHJvdG9jb2w='});
    await Promise.race([ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('sample did not reach barrier')),3000))]);
    const replacement=await connect({token:d.token});
    unblock();
    const state=await call(replacement,'heartbeat',{});
    assert.equal(state.screenConsented,false);assert.equal(state.cameraConsented,false);
    await new Promise(r=>setTimeout(r,100));
    assert.equal(previews.length,0,'Disconnected sample must not be forwarded after its database await');
    assert.equal((await f.request('/sessions/'+sid+'/events',null,f.token)).data.some(e=>e.kind==='rule_alert'),false,'Unavailable metadata is technical, not a rule alert');
    await call(replacement,'consent',{sessionId:sid,accept:true});
    assert.equal((await call(replacement,'heartbeat',{})).screenConsented,true);
    await f.request('/devices/'+d.id+'/revoke',{},f.token);
    assert.equal(f.online.has(d.id),false);
    await new Promise(r=>setTimeout(r,50));assert.equal(previews.length,0);
  }finally{for(const s of clients)s.disconnect();await f.close();}
});


test('individual controls preserve consent boundaries, isolate classmates and reject expired monitoring',async()=>{
  const f=await fixture(),clients=[];
  const call=(s,n,p)=>s.timeout(3000).emitWithAck(n,p);
  try{
    const paper=(await f.request('/papers',uploadForm(await actualPaper(),{durationMinutes:'5'}),f.token)).data.id;
    const sid=(await f.request('/sessions',{name:'Combined control/monitoring fixture'},f.token)).data.id;
    await f.request('/sessions/'+sid+'/paper',{paperId:paper},f.token);
    const peers=[];
    for(let i=0;i<2;i++){
      const d=await f.enroll('Combined protocol fixture '+i),student=(await f.launch(d)).data.token;
      await f.request('/student/exam',null,student);
      await f.request('/student/exam/start',{focusConsent:false},student);
      const s=io(f.base,{auth:{token:d.token},reconnection:false});clients.push(s);
      await new Promise((resolve,reject)=>{s.once('connect',resolve);s.once('connect_error',reject)});
      await call(s,'heartbeat',{});await call(s,'consent',{sessionId:sid,accept:true});
      peers.push({d,s});
    }
    const progress=(await f.request('/sessions/'+sid+'/exam-status',null,f.token)).data;
    const attempt=progress.students.find(x=>x.device_id===peers[0].d.id).attempt_id;
    const path='/sessions/'+sid+'/attempts/'+attempt+'/control';
    const command=action=>({action,commandId:randomUUID(),reason:'Explicit human control fixture'});
    assert.equal((await f.request(path,command('pause'),f.token)).status,200);
    await call(peers[0].s,'consent',{sessionId:sid,accept:false});
    const resume=command('resume');
    const first=await f.request(path,resume,f.token),duplicate=await f.request(path,resume,f.token);
    assert.equal(first.data.receipt.id,duplicate.data.receipt.id);
    assert.equal((await call(peers[0].s,'heartbeat',{})).screenConsented,false,'Resume must not restore withdrawn consent');
    assert.equal((await call(peers[1].s,'heartbeat',{})).screenConsented,true);
    await call(peers[0].s,'consent',{sessionId:sid,accept:true});
    const ended=new Promise(r=>peers[0].s.once('exam-finished',r));
    assert.equal((await f.request(path,command('end'),f.token)).status,200);await ended;
    assert.equal((await call(peers[0].s,'heartbeat',{})).screenConsented,false);
    assert.equal((await call(peers[1].s,'heartbeat',{})).screenConsented,true,'Ending one attempt must not stop classmates');
    assert.match((await call(peers[0].s,'sample',{sessionId:sid,app:'fixture.exe',jpeg:'/9j/cHJvdG9jb2w='})).error,/authorized/);
    // Explicit protocol lease-clock boundary; not a physical network or camera claim.
    f.online.get(peers[1].d.id).lastSeen=Date.now()-9000;
    assert.match((await call(peers[1].s,'sample',{sessionId:sid,app:'fixture.exe',jpeg:'/9j/cHJvdG9jb2w='})).error,/authorized/);
    assert.equal((await call(peers[1].s,'heartbeat',{})).screenConsented,false);
    await f.request('/sessions/'+sid+'/end',{},f.token);
    assert.equal((await call(peers[1].s,'heartbeat',{})).session,null);
  }finally{for(const s of clients)s.disconnect();await f.close()}
});
