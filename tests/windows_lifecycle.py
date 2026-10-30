"""Visible native acceptance; run only through windows-lifecycle.mjs with isolated data.
No screen pixels are saved and no camera is opened."""
import base64
import io
import json
import os
from pathlib import Path
import queue
import sys
import threading
import time
import tkinter as tk
import requests
import socketio
from PIL import Image

if os.environ.get('EXAMOS_NATIVE_TEST_APPROVED')!='visible-screen-lifecycle':
    raise SystemExit('Explicit visible-screen lifecycle test authorization required')
os.environ['EXAMOS_CONFIG_PATH'] = os.environ['EXAMOS_ISOLATED_CONFIG']
sys.path.insert(0, str(Path('agent').resolve()))
from agent import Agent
import agent as student_module

# Instrument the real native capture/process calls; their actual results still flow to the server.
captures = []
application_queries = []
resource_releases=[]
native_close=student_module.MSS.close
def counted_close(self):
    native_close(self)
    resource_releases.append(time.monotonic())
student_module.MSS.close=counted_close
native_grab = student_module.MSS.grab
native_foreground_process = student_module.win32process.GetWindowThreadProcessId
def counted_grab(self, monitor):
    captures.append(time.monotonic())
    return native_grab(self, monitor)
def counted_foreground_process(window):
    application_queries.append(time.monotonic())
    return native_foreground_process(window)
student_module.MSS.grab = counted_grab
student_module.win32process.GetWindowThreadProcessId = counted_foreground_process

base = os.environ['EXAMOS_TEST_URL']
api_base=os.environ['EXAMOS_TEST_API_URL']
login = json.loads(os.environ['EXAMOS_TEST_LOGIN'])
token = requests.post(api_base+'/api/login', json={'email': login['Email'], 'password': login['Password']}, timeout=5).json()['token']
headers = {'Authorization': 'Bearer '+token}
def api(path, payload=None):
    r = requests.request('POST' if payload is not None else 'GET', api_base+'/api'+path, json=payload, headers=headers, timeout=8)
    r.raise_for_status()
    return r.json()

assert not any(s['status'] == 'active' for s in api('/state')['sessions']), 'End the active examination before running validation'
code = api('/enrollment', {})['code']
root = tk.Tk()
agent = Agent(root)
root.title('ExamOS — VISIBLE LOCAL INTEGRATION TEST')
root.lift()
root.focus_force()
agent.url.delete(0, 'end')
agent.url.insert(0, base)
agent.name.delete(0, 'end')
agent.name.insert(0, 'Windows validation device')
agent.code.insert(0, code)
commands = queue.Queue()
frames = []
failures = []
stop_latencies = []
measurements_report={}
stop_notifications = []
teacher = socketio.Client(reconnection=False)
@teacher.on('monitoring-stopped')
def monitoring_stopped(data):
    stop_notifications.append(data)
@teacher.on('preview')
def preview(data):
    image = Image.open(io.BytesIO(base64.b64decode(data['jpeg'])))
    image.verify()
    frames.append((data['app'], time.monotonic()))

def wait_for(predicate, label, timeout=12):
    deadline = time.monotonic()+timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(.1)
    raise AssertionError('Timed out: '+label+'; pending='+str(agent.consent_pending)+'; stopping='+str(agent.stopping)+'; window='+root.state())

def accept_on_visible_test_window():
    root.deiconify()
    root.lift()
    root.focus_force()
    agent.accept_button.invoke()

def resume_sharing():
    commands.put(root.deiconify)
    wait_for(lambda: not agent.consent_pending and agent.root.state()!='iconic', 'previous consent acknowledgment')
    wait_for(lambda: agent.accept_button.cget('state')=='normal' and agent.accept_button.cget('text')=='I consent — start sharing', 'initial consent control available')
    count = len(frames)
    commands.put(accept_on_visible_test_window)
    wait_for(lambda: len(frames) > count, 'sharing after explicit re-consent')

def stop_and_verify(trigger, reason):
    stopped = threading.Event()
    measurements = {}
    previous_notifications = len(stop_notifications)
    def perform_stop():
        started = time.monotonic()
        trigger()
        stop_latencies.append(time.monotonic()-started)
        measurements.update(captures=len(captures), applications=len(application_queries), allowed=agent.gate.allowed())
        stopped.set()
    commands.put(perform_stop)
    assert stopped.wait(5), 'Stop control blocked the UI'
    assert not measurements['allowed'], 'Capture still authorized when stop control returned'
    assert stop_latencies[-1] < .5, 'Local stop waited on network I/O'
    wait_for(lambda: len(stop_notifications) > previous_notifications, 'immediate teacher stop notification')
    assert reason in stop_notifications[-1]['reason']
    wait_for(lambda: not agent.consent_pending, 'withdrawal audit acknowledgment')
    state = api('/state')['devices']
    own = next(d for d in state if d['id']==agent.config['id'])
    assert own['online'] and not own['consented'] and own['app'] is None
    time.sleep(.3)
    count = len(frames)
    time.sleep(2.2)
    assert len(frames)==count, 'Preview transmitted after stopping'
    assert len(captures)==measurements['captures'], 'Native screen capture ran after stopping'
    assert len(application_queries)==measurements['applications'], 'Foreground application queried after stopping'
    events=api('/sessions/'+agent.gate.session['id']+'/events')
    assert any(e['kind']=='consent_withdrawn' and reason in e['detail'].get('reason','') for e in events)

def test_workflow():
    session = None
    try:
        teacher.connect(api_base, auth={'role': 'teacher', 'token': token})
        commands.put(agent.connect)
        wait_for(lambda: agent.client and agent.client.connected, 'agent enrollment and connection')
        assert Path(os.environ['EXAMOS_CONFIG_PATH']).exists(), 'DPAPI credential missing'
        assert not agent.gate.allowed()
        session = api('/sessions', {'name': 'Windows end-to-end validation', 'allowedApps': ['examos-validation.exe']})['id']
        wait_for(lambda: agent.gate.session and agent.gate.session['id'] == session, 'session notification')
        time.sleep(2.5)
        assert not frames, 'Screen sent before consent'
        assert not captures and not application_queries, 'Monitoring ran before initial consent'
        assert agent.accept_button.cget('text') == 'I consent — start sharing'
        assert root.bind('<Escape>'), 'Accessible keyboard stop shortcut missing'
        commands.put(accept_on_visible_test_window)
        wait_for(lambda: len(frames) >= 2, 'two real JPEG previews')
        assert agent.status.cget('text') == '● MONITORING ACTIVE'
        assert root.winfo_viewable() and root.attributes('-topmost'), 'Active monitoring indicator is not persistently visible'
        assert agent.accept_button.cget('text') == 'Stop monitoring (Esc)'
        assert frames[0][0].endswith('.exe'), 'Real executable name missing'
        events = api('/sessions/'+session+'/events')
        assert any(e['kind'] == 'rule_alert' for e in events)
        alert = next(e for e in events if e['kind'] == 'rule_alert')
        api('/events/'+alert['id']+'/review', {'review': 'Automated local validation: real foreground app observed; no misconduct finding.'})
        stop_and_verify(agent.accept_button.invoke, 'Student stopped monitoring')
        resume_sharing()
        stop_and_verify(lambda: root.event_generate('<Escape>'), 'using Escape')
        resume_sharing()
        def stop_at_lease_expiry():
            with agent.gate.lock:
                agent.gate.lease_until=time.monotonic()-1
            agent.accept_button.invoke()
        stop_and_verify(stop_at_lease_expiry, 'Student stopped monitoring')
        # Cancel an in-flight consent grant: a late acknowledgment must never restart capture.
        pending_cancelled = threading.Event()
        capture_count = len(captures)
        def cancel_pending_consent():
            agent.accept()
            agent.withdraw('keyboard_stop')
            pending_cancelled.set()
        commands.put(cancel_pending_consent)
        assert pending_cancelled.wait(5)
        wait_for(lambda: not agent.consent_pending, 'pending consent cancellation acknowledgment')
        time.sleep(2.2)
        assert not agent.gate.allowed() and len(captures)==capture_count
        resume_sharing()
        # A real reply is delayed locally; stopping must invalidate its consent generation.
        original_call=agent.server_call
        granted_reply=threading.Event()
        release_reply=threading.Event()
        stop_and_verify(agent.withdraw,'Student stopped monitoring')
        def delayed_reply(client,name,payload,timeout,cancel=None):
            response=original_call(client,name,payload,timeout,cancel)
            if name=='consent' and payload.get('accept'):
                granted_reply.set()
                release_reply.wait(4)
            return response
        agent.server_call=delayed_reply
        commands.put(accept_on_visible_test_window)
        assert granted_reply.wait(8)
        cancelling_generation=agent.consent_generation
        commands.put(lambda:agent.withdraw('keyboard_stop'))
        wait_for(lambda:not agent.gate.allowed() and agent.consent_generation>cancelling_generation,'stale grant disabled')
        release_reply.set()
        wait_for(lambda:not agent.consent_pending,'late consent acknowledgement settled')
        agent.server_call=original_call
        count=len(captures)
        time.sleep(2.2)
        assert not agent.gate.allowed() and len(captures)==count
        measurements_report['lateRealConsentAckCannotResume']=True
        resume_sharing()
        print('PASS: stale consent acknowledgement cannot resume native capture',flush=True)
        # A real heartbeat says no consent, but its delayed reply must not cancel a NEWER grant.
        stop_and_verify(agent.withdraw,'Student stopped monitoring')
        negative_reply=threading.Event()
        release_heartbeat=threading.Event()
        held_once=threading.Event()
        def delayed_heartbeat(client,name,payload,timeout,cancel=None):
            response=original_call(client,name,payload,timeout,cancel)
            if name=='heartbeat' and response.get('screenConsented') is False and not held_once.is_set():
                held_once.set();negative_reply.set();release_heartbeat.wait(4)
            return response
        agent.server_call=delayed_heartbeat
        assert negative_reply.wait(8)
        commands.put(accept_on_visible_test_window)
        wait_for(agent.gate.allowed,'new explicit consent accepted while old heartbeat reply is held')
        release_heartbeat.set()
        agent.server_call=original_call
        time.sleep(.4)
        assert agent.gate.allowed(),'Old negative heartbeat cancelled a newer grant'
        measurements_report['oldNegativeHeartbeatCannotCancelNewGrant']=True
        print('PASS: delayed negative heartbeat cannot cancel a newer explicit consent',flush=True)
        # Actual loopback transport failure; no fake heartbeat or capture result.
        fault_start=time.monotonic()
        requests.post(base+'/__test/transport',headers={'X-Test-Control':os.environ['EXAMOS_TEST_CONTROL']},json={'blocked':True},timeout=3).raise_for_status()
        wait_for(lambda:not agent.gate.allowed(),'network loss disables native publication',8)
        measurements_report['networkEligibilityStopSeconds']=round(time.monotonic()-fault_start,3)
        assert measurements_report['networkEligibilityStopSeconds']<=6.75
        wait_for(lambda:not agent.client.connected,'failed transport disconnect',15)
        wait_for(lambda:resource_releases and resource_releases[-1]>=fault_start,'native MSS context release',12)
        measurements_report['networkNativeResourceReleaseSeconds']=round(min(t for t in resource_releases if t>=fault_start)-fault_start,3)
        count=len(captures)
        time.sleep(2.2)
        assert len(captures)==count
        requests.post(base+'/__test/transport',headers={'X-Test-Control':os.environ['EXAMOS_TEST_CONTROL']},json={'blocked':False},timeout=3).raise_for_status()
        commands.put(agent.connect)
        wait_for(lambda:agent.client and agent.client.connected and agent.gate.session,'native manual reconnect')
        time.sleep(2.2)
        assert not agent.gate.allowed() and len(captures)==count
        measurements_report['reconnectRequiresFreshConsent']=True
        print('PASS: actual transport failure, resource release and manual reconnect with fresh consent',flush=True)
        resume_sharing()
        # A second real Socket.IO connection replaces the native connection, without inherited consent.
        duplicate=socketio.Client(reconnection=False)
        duplicate.connect(base,auth={'token':agent.config['token']},transports=['polling'])
        wait_for(lambda:not agent.gate.allowed() and not agent.client.connected,'duplicate replaces native agent')
        reply=duplicate.call('heartbeat',{},timeout=4)
        assert reply['screenConsented'] is False and reply['cameraConsented'] is False
        duplicate.disconnect()
        commands.put(agent.connect)
        wait_for(lambda:agent.client and agent.client.connected and agent.gate.session,'reconnect after duplicate')
        assert not agent.gate.allowed()
        measurements_report['duplicateConnectionRequiresFreshConsent']=True
        print('PASS: duplicate connection stops native capture and does not inherit consent',flush=True)
        resume_sharing()
        commands.put(root.iconify)
        wait_for(lambda: not agent.gate.allowed(), 'minimizing stops monitoring')
        wait_for(lambda: not agent.consent_pending, 'minimize audit acknowledgment')
        assert any('minimized' in p['reason'] for p in stop_notifications)
        count = len(captures)
        time.sleep(2.2)
        assert len(captures)==count, 'Capture continued while minimized'
        commands.put(root.deiconify)
        resume_sharing()
        # Configure a real short paper window; the server/agent enforce the actual deadline.
        from datetime import datetime,timedelta,timezone
        with open('tests/fixtures/mathematics-question-paper.pdf','rb') as pdf:
            upload=requests.post(api_base+'/api/papers',headers=headers,files={'pdf':('paper.pdf',pdf,'application/pdf')},data={'title':'Native expiry acceptance','subject':'Lifecycle','totalMarks':'1','durationMinutes':'1'},timeout=8)
        upload.raise_for_status()
        closes=(datetime.now(timezone.utc)+timedelta(seconds=14)).isoformat()
        api('/sessions/'+session+'/paper',{'paperId':upload.json()['id'],'closesAt':closes})
        device_headers={'Authorization':'Bearer '+agent.config['token']}
        launch=requests.post(api_base+'/api/student/launch',headers=device_headers,json={},timeout=4).json()
        exchange=requests.post(api_base+'/api/student/exchange',json={'code':launch['code']},timeout=4).json()
        student_headers={'Authorization':'Bearer '+exchange['token']}
        requests.get(api_base+'/api/student/exam',headers=student_headers,timeout=4).raise_for_status()
        requests.post(api_base+'/api/student/exam/start',headers=student_headers,json={'focusConsent':False},timeout=4).raise_for_status()
        wait_for(lambda:agent.exam_state and agent.exam_state.get('status')=='started','native sees real started examination')
        wait_for(lambda:not agent.gate.allowed(),'real examination deadline stops native capture',18)
        count=len(captures)
        time.sleep(2.2)
        assert len(captures)==count
        measurements_report['actualServerDeadlineStoppedCapture']=True
        print('PASS: actual examination deadline stopped native capture',flush=True)
        if any(s['id']==session and s['status']=='active' for s in api('/state')['sessions']):
            api('/sessions/'+session+'/end', {})
        wait_for(lambda: not agent.gate.allowed() and agent.gate.session is None, 'stop on session end')
        time.sleep(.5)
        count = len(frames)
        time.sleep(3)
        assert len(frames) == count, 'Preview after session end'
        session = api('/sessions', {'name':'Close-window consent validation'})['id']
        wait_for(lambda: agent.gate.session and agent.gate.session['id']==session, 'new examination requires fresh consent')
        assert not agent.gate.allowed()
        resume_sharing()
        revoked_id=agent.config['id']
        api('/devices/'+revoked_id+'/revoke',{})
        wait_for(lambda:not agent.gate.allowed() and not agent.client.connected,'revocation stops real agent')
        count=len(captures)
        time.sleep(2.2)
        assert len(captures)==count
        rejected=socketio.Client(reconnection=False)
        try:
            rejected.connect(base,auth={'token':agent.config['token']},transports=['polling'],wait_timeout=4)
            raise AssertionError('Revoked credential reconnected')
        except socketio.exceptions.ConnectionError:
            pass
        measurements_report['revocationStopsAndRejectsCredential']=True
        replacement_code=api('/enrollment',{})['code']
        def reenroll():
            agent.code.delete(0,'end')
            agent.code.insert(0,replacement_code)
            agent.connect()
        commands.put(reenroll)
        wait_for(lambda:agent.config['id']!=revoked_id and agent.client.connected and agent.gate.session,'new actual enrollment after revocation')
        assert not agent.gate.allowed()
        resume_sharing()
        commands.put(agent.close)
        wait_for(lambda: any('closed' in p['reason'] for p in stop_notifications), 'closing records consent withdrawal before disconnect')
        wait_for(lambda: not agent.client.connected, 'closed window disconnects')
        close_history=api('/sessions/'+session+'/events')
        assert any(e['kind']=='consent_withdrawn' and 'closed' in e['detail'].get('reason','') for e in close_history)
        assert not agent.gate.allowed()
        print(json.dumps({'result':'PASS','lifecycle':measurements_report, 'real_jpeg_previews':len(frames), 'foreground_apps':sorted(set(f[0] for f in frames)), 'local_stop_seconds':stop_latencies, 'verified':['initial consent only','MONITORING ACTIVE indicator','single context-sensitive stop control','Escape stop','native capture and application queries cease on stop','teacher stop notification and audit','pending consent cannot restart capture','minimize stops monitoring','fresh explicit re-consent','DPAPI enrollment','real Windows screen and process','rule alert and review','session end stops capture','closing stops monitoring and records withdrawal']}, indent=2))
    except Exception as exc:
        failures.append(str(exc))
        import traceback
        print(traceback.format_exc(),flush=True)
        print('FAIL:', exc)
        print('Gate:', agent.gate.accepted, agent.gate.allowed(), 'indicator:', agent.indicator_ready, 'connected:', bool(agent.client and agent.client.connected))
        if session:
            print('Recorded events:', [(e['kind'], e['detail']) for e in api('/sessions/'+session+'/events')])
    finally:
        if session:
            try:
                api('/sessions/'+session+'/end', {})
            except requests.HTTPError:
                pass
        if agent.config:
            api('/devices/'+agent.config['id']+'/revoke', {})
        teacher.disconnect()
        commands.put(agent.close)

def poll():
    try:
        while True:
            commands.get_nowait()()
    except queue.Empty:
        pass
    try:
        if root.winfo_exists():
            root.after(100, poll)
    except tk.TclError:
        pass

root.after(200, poll)
workflow=threading.Thread(target=test_workflow, daemon=True)
workflow.start()
root.mainloop()
workflow.join(timeout=15)
if failures:
    raise SystemExit(1)
