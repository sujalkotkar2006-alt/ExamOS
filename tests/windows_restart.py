"""Opt-in real Windows source agent versus an actual isolated backend process restart."""
import json,os,queue,sys,threading,time,tkinter as tk
from pathlib import Path
import requests
if os.environ.get('EXAMOS_NATIVE_TEST_APPROVED')!='visible-screen-lifecycle':
    raise SystemExit('Visible native screen acceptance required')
sys.path.insert(0,str(Path('agent').resolve()))
from agent import Agent
import agent as module
base=os.environ['EXAMOS_TEST_URL']
login=json.loads(os.environ['EXAMOS_TEST_LOGIN'])
token=requests.post(base+'/api/login',json=login,timeout=4).json()['token']
headers={'Authorization':'Bearer '+token}
def api(path,payload=None):
    response=requests.request('POST' if payload is not None else 'GET',base+'/api'+path,headers=headers,json=payload,timeout=5)
    response.raise_for_status();return response.json()
def control(action):
    response=requests.post(os.environ['EXAMOS_RESTART_CONTROL']+'/'+action,headers={'X-Test-Control':os.environ['EXAMOS_RESTART_SECRET']},timeout=20)
    response.raise_for_status()
captures=[]
grab=module.MSS.grab
def counted_grab(self,monitor):
    captures.append(time.monotonic());return grab(self,monitor)
module.MSS.grab=counted_grab
root=tk.Tk();agent=Agent(root);root.title('ExamOS — VISIBLE ISOLATED BACKEND RESTART TEST')
agent.url.delete(0,'end');agent.url.insert(0,base)
agent.name.delete(0,'end');agent.name.insert(0,'Native restart acceptance device')
agent.code.insert(0,api('/enrollment',{})['code'])
commands=queue.Queue();failures=[]
def wait(predicate,label,timeout=15):
    until=time.monotonic()+timeout
    while time.monotonic()<until:
        if predicate():return
        time.sleep(.1)
    raise AssertionError('Timeout: '+label)
def flow():
    try:
        commands.put(agent.connect)
        wait(lambda:agent.client and agent.client.connected,'native enrollment')
        first=api('/sessions',{'name':'Actual native restart session'})['id']
        wait(lambda:agent.gate.session and agent.gate.session['id']==first,'first session')
        assert not agent.gate.allowed() and not captures
        commands.put(agent.accept)
        wait(lambda:len(captures)>=2,'actual native screen capture')
        started=time.monotonic();control('stop')
        wait(lambda:not agent.gate.allowed(),'local stop after actual backend process termination',8)
        stopped=time.monotonic()-started
        assert stopped<=6.75
        wait(lambda:not agent.client.connected,'native disconnect')
        count=len(captures);time.sleep(2.2);assert len(captures)==count
        control('start')
        assert next(s for s in api('/state')['sessions'] if s['id']==first)['status']=='ended'
        assert not agent.client.connected,'Native client silently reconnected'
        commands.put(agent.connect)
        wait(lambda:agent.client and agent.client.connected,'manual native reconnect')
        time.sleep(2.2)
        assert agent.gate.session is None and not agent.gate.allowed() and len(captures)==count
        second=api('/sessions',{'name':'Native restart follow-up'})['id']
        wait(lambda:agent.gate.session and agent.gate.session['id']==second,'new session')
        time.sleep(2.2);assert not agent.gate.allowed() and len(captures)==count
        commands.put(agent.accept)
        wait(lambda:len(captures)>count,'fresh consent resumes actual screen capture')
        time.sleep(2)
        # Combined incoming teacher controls versus real native monitoring.
        import uuid
        with open('tests/fixtures/mathematics-question-paper.pdf','rb') as pdf:
            response=requests.post(base+'/api/papers',headers=headers,files={'pdf':('paper.pdf',pdf,'application/pdf')},data={'title':'Native controls acceptance','subject':'Lifecycle','totalMarks':'1','durationMinutes':'1'},timeout=5)
        response.raise_for_status()
        api('/sessions/'+second+'/paper',{'paperId':response.json()['id']})
        device_headers={'Authorization':'Bearer '+agent.config['token']}
        launch=requests.post(base+'/api/student/launch',headers=device_headers,json={},timeout=5).json()
        student=requests.post(base+'/api/student/exchange',json={'code':launch['code']},timeout=5).json()['token']
        student_headers={'Authorization':'Bearer '+student}
        requests.get(base+'/api/student/exam',headers=student_headers,timeout=5).raise_for_status()
        requests.post(base+'/api/student/exam/start',headers=student_headers,json={'focusConsent':False},timeout=5).raise_for_status()
        saved=requests.post(base+'/api/student/exam/save',headers=student_headers,json={'answers':'Acknowledged native test response','revision':0,'mutationId':str(uuid.uuid4())},timeout=5)
        saved.raise_for_status()
        attempt=requests.get(base+'/api/student/exam',headers=student_headers,timeout=5).json()['attempt']
        path='/sessions/'+second+'/attempts/'+attempt['id']+'/control'
        command=lambda action:{'action':action,'reason':'Explicit isolated teacher control test','commandId':str(uuid.uuid4())}
        api(path,command('pause'))
        commands.put(agent.withdraw)
        wait(lambda:not agent.gate.allowed() and not agent.consent_pending,'withdrawal during teacher pause')
        count=len(captures);api(path,command('resume'));time.sleep(2.2)
        assert not agent.gate.allowed() and len(captures)==count,'Teacher resume restored withdrawn native capture'
        commands.put(agent.accept);wait(lambda:len(captures)>count,'fresh consent after teacher resume')
        end=command('end');first_receipt=api(path,end);duplicate=api(path,end)
        assert first_receipt['receipt']['id']==duplicate['receipt']['id'] and duplicate['duplicate']
        wait(lambda:not agent.gate.allowed(),'individual teacher end stops native capture')
        ended=requests.get(base+'/api/student/exam',headers=student_headers,timeout=5).json()['attempt']
        assert ended['submission_reason']=='teacher_ended' and ended['answers']=='Acknowledged native test response'
        assert next(s for s in api('/state')['sessions'] if s['id']==second)['status']=='active'
        print('PASS: real native withdrawal during pause, no resume without fresh consent, replay-safe individual teacher end and acknowledged-answer preservation',flush=True)
        api('/sessions/'+second+'/end',{})
        wait(lambda:not agent.gate.allowed(),'new session ends')
        print(json.dumps({'result':'PASS','actualBackendProcessRestart':True,'actualWindowsSourceCapture':True,'nativeStopObservedSeconds':round(stopped,3),'noSilentReconnectOrCapture':True,'endedSessionPreserved':True,'freshSessionAndConsentRequired':True,'cameraAccessed':False}),flush=True)
    except Exception as exc:
        failures.append(type(exc).__name__+': '+str(exc));print('FAIL:',failures[-1],flush=True)
    finally:
        commands.put(agent.close)
def poll():
    try:
        while True:commands.get_nowait()()
    except queue.Empty:pass
    if root.winfo_exists():root.after(100,poll)
root.after(100,poll);worker=threading.Thread(target=flow,daemon=True);worker.start();root.mainloop();worker.join(10)
if failures:raise SystemExit(1)
