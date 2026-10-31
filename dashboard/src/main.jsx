import { apiFetch, BACKEND_ORIGIN } from "./backend.js";
import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { io } from "socket.io-client";
import "./style.css";
import QuestionPapers, { ExamProgress } from "./QuestionPapers.jsx";
import ScreenMonitor from "./ScreenMonitor.jsx";
import StudentExam from "./StudentExam.jsx";
import EvidenceCentre from "./EvidenceCentre.jsx";
import LiveProctoring, { PrivateMedia } from "./LiveProctoring.jsx";
const pages = {
  dashboard: "Dashboard",
  live: "Live Proctoring",
  examinations: "Examinations",
  students: "Students",
  evidence: "Evidence Centre",
  incidents: "Incident History",
  settings: "Settings",
};
const readRoute = () => {
  const [raw, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  return { page: Object.hasOwn(pages, raw) ? raw : "dashboard", query };
};
function App() {
  const [token, setToken] = useState(
      sessionStorage.getItem("examos-token") || "",
    ),
    [state, setState] = useState({ devices: [], sessions: [] }),
    [error, setError] = useState(""),
    [code, setCode] = useState(null),
    [selected, setSelected] = useState(""),
    [events, setEvents] = useState([]),
    [previews, setPreviews] = useState({}),
    [connected, setConnected] = useState(false);
  const selection = useRef("");
  const [route, setRoute] = useState(readRoute),
    [summary, setSummary] = useState(null),
    [recentMedia, setRecentMedia] = useState([]),
    [loaded, setLoaded] = useState(false);
  const navigate = (page, params = {}) => {
    const query = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v),
    );
    location.hash = "/" + page + (query.size ? "?" + query : "");
  };
  useEffect(() => {
    const sync = () => setRoute(readRoute());
    window.addEventListener("hashchange", sync);
    if (!location.hash.startsWith("#/"))
      history.replaceState({}, "", location.pathname + "#/dashboard");
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  const [proctorRevision, setProctorRevision] = useState(0);
  const [latestIncident, setLatestIncident] = useState(null),
    [selectedIncident, setSelectedIncident] = useState(null),
    [pendingCount, setPendingCount] = useState(0);
  const latestRef = useRef(null),
    evidenceRefresh = useRef(0);
  latestRef.current = latestIncident;
  useEffect(() => {
    setLatestIncident(null);
    setSelectedIncident(null);
    setPendingCount(0);
  }, [token]);
  const [enrollmentNow, setEnrollmentNow] = useState(Date.now());
  useEffect(() => {
    if (!code || code.used) return;
    setEnrollmentNow(Date.now());
    const timer = setInterval(() => setEnrollmentNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [code?.codeId, code?.used]);
  const refreshVersion = useRef(0);
  selection.current = selected;
  const api = async (url, body) => {
    const r = await apiFetch("/api" + url, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await r.json();
    if (!r.ok) {
      if (r.status === 401 && token) {
        sessionStorage.removeItem("examos-token");
        setToken("");
      }
      throw Error(data.error || "Request failed");
    }
    return data;
  };
  const refresh = async () => {
    const version = ++refreshVersion.current;
    const results = await Promise.allSettled([
      api("/state"),
      api("/proctor/summary"),
      api("/proctor/evidence?status=available&limit=4"),
    ]);
    if (version !== refreshVersion.current) return;
    if (results[0].status === "rejected") throw results[0].reason;
    const s = results[0].value;
    if (results[1].status === "fulfilled") setSummary(results[1].value);
    else setError("Dashboard counters: " + results[1].reason.message);
    if (results[2].status === "fulfilled")
      setRecentMedia(results[2].value.items);
    else setError("Evidence listing: " + results[2].reason.message);
    setLoaded(true);
    if (version !== refreshVersion.current) return;
    setState(s);
    if (!selection.current && s.sessions.length) setSelected(s.sessions[0].id);
    if (selection.current)
      setEvents(await api("/sessions/" + selection.current + "/events"));
  };
  const run = (fn) =>
    Promise.resolve()
      .then(fn)
      .catch((e) => setError(e.message));
  useEffect(() => {
    setPreviews({});
    if (!token) return;
    run(refresh);
    const s = io(BACKEND_ORIGIN || undefined, { auth: { role: "teacher", token } });
    s.on("connect", () => {
      setConnected(true);
      run(refresh);
    });
    s.on("disconnect", () => {
      setConnected(false);
      setPreviews({});
    });
    s.on("connect_error", (e) => setError("Live connection: " + e.message));
    s.on("refresh", () => run(refresh));
    s.on("proctor-refresh", () => {
      setProctorRevision((x) => x + 1);
      const id = latestRef.current?.id,
        version = ++evidenceRefresh.current;
      if (id)
        api("/proctor/events/" + id)
          .then((d) => {
            if (version === evidenceRefresh.current)
              setLatestIncident((current) =>
                current?.id === id
                  ? {
                      ...current,
                      has_evidence: d.has_evidence,
                      clip_status: d.clip_status,
                    }
                  : current,
              );
          })
          .catch(() => {});
    });
    s.on("proctor-incident", (incident) => {
      setLatestIncident(incident);
      setProctorRevision((x) => x + 1);
    });
    s.on("proctor-evidence-ready", (incident) =>
      setLatestIncident((current) =>
        current?.id === incident.id ? { ...current, ...incident } : current,
      ),
    );
    s.on("refresh", () => setProctorRevision((x) => x + 1));
    s.on("device-enrolled", (data) =>
      setCode((current) =>
        current?.codeId === data.codeId
          ? { ...current, used: true, deviceName: data.name }
          : current,
      ),
    );
    s.on("disconnect",()=>setPreviews({}));
    s.on("connect_error",()=>setPreviews({}));
    s.on("preview", (p) => setPreviews((old) => ({ ...old, [p.deviceId]: {...p,receivedAt:Date.now()} })));
    s.on("clear-previews", () => setPreviews({}));
    s.on("monitoring-stopped", ({ deviceId }) => {
      refreshVersion.current++;
      setPreviews((old) => {
        const next = { ...old };
        delete next[deviceId];
        return next;
      });
      setState((old) => ({
        ...old,
        devices: old.devices.map((d) =>
          d.id === deviceId ? { ...d, consented: false, app: null } : d,
        ),
      }));
    });
    s.on("device-offline", (id) =>
      setPreviews((old) => {
        const n = { ...old };
        delete n[id];
        return n;
      }),
    );
    const timer = setInterval(() => {
      run(refresh);
      setPreviews((old) =>
        Object.fromEntries(
          Object.entries(old).filter(([, p]) => Date.now() - (p.receivedAt ?? p.at) < 10000),
        ),
      );
    }, 5000);
    return () => {
      s.disconnect();
      clearInterval(timer);
    };
  }, [token]);
  useEffect(() => {
    if (token && selected)
      run(async () =>
        setEvents(await api("/sessions/" + selected + "/events")),
      );
  }, [selected]);
  const active = state.sessions.find((s) => s.status === "active");
  if (!token)
    return (
      <main className="login">
        <div className="brand">◉ ExamOS</div>
        <h1>
          A clear view.
          <br />A fair examination.
        </h1>
        <p>Instructor access · Your local examination network</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.target);
            run(async () => {
              const { token: t } = await api("/login", Object.fromEntries(f));
              sessionStorage.setItem("examos-token", t);
              setError("");
              setToken(t);
              navigate("dashboard");
            });
          }}
        >
          <label>
            Email
            <input name="email" type="email" required autoComplete="username" />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              required
              autoComplete="current-password"
            />
          </label>
          <button>Sign in to ExamOS →</button>
        </form>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <small>
          Monitoring is visible, consent based, and limited to active sessions.
        </small>
      </main>
    );
  return (
    <div className={"vision-app page-" + route.page}>
      <header className="vision-topbar">
        <a className="vision-brand" href="#/dashboard">
          <svg width="34" height="34" viewBox="0 0 40 40" aria-hidden="true">
            <path
              d="M3 20Q20 1 37 20Q20 39 3 20Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            />
            <circle cx="20" cy="20" r="6" fill="currentColor" />
          </svg>
          <span>
            ExamOS <b>Vision</b>
          </span>
        </a>
        <nav aria-label="Teacher navigation">
          {Object.entries(pages).map(([id, label]) => (
            <a
              key={id}
              href={"#/" + id}
              aria-current={route.page === id ? "page" : undefined}
            >
              {label}
            </a>
          ))}
        </nav>
        <div className="teacher-profile">
          <span title={summary?.teacher_email || "Authenticated teacher"}>
            {summary?.teacher_email || "Teacher account"}
          </span>
          <button
            className="secondary"
            onClick={() => {
              sessionStorage.removeItem("examos-token");
              setToken("");
              setPreviews({});
              setState({ devices: [], sessions: [] });
              setEvents([]);
              setSelected("");
              setCode(null);
              setSummary(null);
              setLoaded(false);
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="workspace" id="overview">
        <header className="vision-page-heading">
          <div>
            <span className="eyebrow">EXAMINATION CONTROL CENTRE</span>
            <h1>{pages[route.page]}</h1>
            <p>Visible monitoring. Private evidence. Human review.</p>
            <span className={"connection-pill " + (connected ? "online" : "")}>
              {connected ? "Live connection" : "Reconnecting…"}
            </span>
          </div>
          <button
            onClick={() =>
              run(async () => {
                const c = await api("/enrollment", {});
                setCode({
                  ...c,
                  used: false,
                  until:
                    Date.now() +
                    (new Date(c.expiresAt).getTime() -
                      new Date(c.serverNow).getTime()),
                });
              })
            }
          >
            ＋ Enroll a device
          </button>
        </header>
        {latestIncident && (
          <div className="incident-notification" role="alert">
            <strong>
              {latestIncident.category === "camera_check"
                ? "Camera check"
                : latestIncident.category.startsWith("camera_")
                  ? "Technical camera observation"
                  : "Potential Examination Incident"}{" "}
              — {latestIncident.device_name}
            </strong>
            <p>
              {latestIncident.label} ·{" "}
              {new Date(latestIncident.observed_at).toLocaleString()}
              <br />
              Examination ID: {latestIncident.attempt_id}
              <br />
              Confidence:{" "}
              {typeof latestIncident.confidence === "number"
                ? (latestIncident.confidence * 100).toFixed(1) + "%"
                : "not available"}{" "}
              · Video: {latestIncident.clip_status}
            </p>
            {latestIncident.has_evidence && (
              <PrivateMedia token={token} id={latestIncident.id} />
            )}
            <button
              onClick={() => {
                setSelectedIncident(latestIncident.id);
                navigate("incidents");
                document.getElementById("live-proctoring")?.scrollIntoView();
              }}
            >
              Open latest incident
            </button>
            <button
              className="secondary"
              onClick={() => setLatestIncident(null)}
            >
              Dismiss notification
            </button>
          </div>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
            <button className="secondary" onClick={() => setError("")}>
              Dismiss
            </button>
          </div>
        )}
        {code && (
          <div className="notice">
            <strong>One-use enrollment code</strong>
            <code>{code.used ? "Already used" : code.code}</code>
            <span>
              {code.used
                ? "Device enrolled: " +
                  code.deviceName +
                  ". Generate a new code for another device."
                : enrollmentNow >= code.until
                  ? "Expired — generate a new code."
                  : `Expires in ${Math.max(0, Math.ceil((code.until - enrollmentNow) / 1000))} seconds, at ${new Date(code.until).toLocaleTimeString()}. One device only.`}
            </span>
            <span>Student server URL: {BACKEND_ORIGIN || location.origin}</span>
            <button
              className="secondary"
              disabled={code.used || enrollmentNow >= code.until}
              onClick={() =>
                navigator.clipboard
                  .writeText(code.code)
                  .catch(() =>
                    setError(
                      "Clipboard unavailable. Select and copy the displayed enrollment code.",
                    ),
                  )
              }
            >
              Copy enrollment code
            </button>
            <button className="secondary" onClick={() => setCode(null)}>
              Close
            </button>
          </div>
        )}
        {route.page === "dashboard" && (
          <>
            <section className="vision-stats" aria-label="Examination overview">
              {[
                ["Active examinations", "active_examinations"],
                ["Connected students", "connected_students"],
                ["Cameras active", "active_cameras"],
                ["Pending incidents", "pending_incidents"],
                ["Snapshots captured", "snapshots_available"],
                ["Video recordings", "videos_available"],
              ].map(([label, key]) => (
                <article key={key}>
                  <span>{label}</span>
                  <strong>{summary ? summary[key] : "…"}</strong>
                  <small>
                    {key === "snapshots_available" && summary
                      ? summary.snapshots_captured + " captured in total"
                      : key === "videos_available"
                        ? "Available event clips"
                        : key === "pending_incidents"
                          ? "Awaiting teacher review"
                          : "Current server state"}
                  </small>
                </article>
              ))}
            </section>
            <section className="vision-overview-grid">
              <article className="panel control-card">
                <span className="eyebrow">EXAMINATION WORKFLOW</span>
                <h2>
                  {active ? active.name : "Ready for your next examination"}
                </h2>
                <p>
                  {active
                    ? "An examination session is active. Open Live Proctoring to check student status and consent."
                    : "Upload a question paper, start a session, and enroll students. Cameras remain off until students explicitly consent."}
                </p>
                <div className="card-actions">
                  <button onClick={() => navigate("examinations")}>
                    Manage examinations
                  </button>
                  <button
                    className="secondary"
                    onClick={() => navigate("live")}
                  >
                    Open Live Proctoring
                  </button>
                </div>
              </article>
              <article className="panel">
                <span className="eyebrow">EVIDENCE AT A GLANCE</span>
                <h2>Capture is explicit</h2>
                <p>
                  Screen previews, saved webcam snapshots and silent video clips
                  are different. Only consented, uploaded media appears in the
                  Evidence Centre.
                </p>
                <button
                  className="secondary"
                  onClick={() => navigate("evidence")}
                >
                  Open Evidence Centre
                </button>
              </article>
            </section>
            <section className="panel">
              <div className="section-head">
                <div>
                  <span className="eyebrow">LATEST UPLOADED MEDIA</span>
                  <h2>Recent evidence</h2>
                </div>
                <button
                  className="text-button"
                  onClick={() => navigate("evidence")}
                >
                  View all evidence →
                </button>
              </div>
              {!loaded ? (
                <p>Loading evidence…</p>
              ) : !recentMedia.length ? (
                <div className="empty">
                  No evidence has been uploaded. A consented camera check during
                  a started examination creates a real saved snapshot.
                </div>
              ) : (
                <div className="evidence-grid">
                  {recentMedia.map((a) => (
                    <article className="evidence-card" key={a.id}>
                      {a.kind === "snapshot" ? (
                        <PrivateMedia token={token} evidenceId={a.id} />
                      ) : (
                        <div className="video-open">
                          ▶ Actual video recording
                        </div>
                      )}
                      <div className="evidence-caption">
                        <strong>{a.student_name}</strong>
                        <p>
                          {a.kind === "snapshot"
                            ? "Snapshot"
                            : "Video recording"}{" "}
                          · {a.label}
                        </p>
                        <time>{new Date(a.captured_at).toLocaleString()}</time>
                        <button
                          className="text-button"
                          onClick={() =>
                            navigate("evidence", {
                              studentId: a.student_id,
                              sessionId: a.session_id,
                            })
                          }
                        >
                          Open evidence
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
        <div hidden={route.page !== "examinations"}>
          <section className="panel" id="sessions">
            <div className="section-head">
              <div>
                <h2>{active ? active.name : "Start an examination"}</h2>
                <p>
                  {active
                    ? "Students choose whether to share their screen and active application."
                    : "Create a session, then ask students to review and accept the consent prompt."}
                </p>
              </div>
              {active && (
                <button
                  className="danger"
                  onClick={() =>
                    run(async () => {
                      await api("/sessions/" + active.id + "/end", {});
                      setPreviews({});
                      await refresh();
                    })
                  }
                >
                  End session & stop monitoring
                </button>
              )}
            </div>
            {!active && (
              <form
                className="session-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.target);
                  run(async () => {
                    const s = await api("/sessions", {
                      name: f.get("name"),
                      allowedApps: f
                        .get("apps")
                        .split(",")
                        .map((x) => x.trim())
                        .filter(Boolean),
                    });
                    setSelected(s.id);
                    await refresh();
                  });
                }}
              >
                <label>
                  Examination name
                  <input
                    name="name"
                    placeholder="e.g. Mathematics · Semester 1"
                    required
                    maxLength={120}
                  />
                </label>
                <label>
                  Allowed executable names (optional)
                  <input
                    name="apps"
                    placeholder="msedge.exe, calculatorapp.exe"
                  />
                </label>
                <button>Start session →</button>
              </form>
            )}
            {active && (
              <div className="notice">
                Allowed applications:{" "}
                {active.allowed_apps.length
                  ? active.allowed_apps.join(", ")
                  : "No application restrictions"}
                . Alerts request teacher review; they do not determine cheating.
              </div>
            )}
          </section>
        </div>
        <div hidden={!["live", "students"].includes(route.page)}>
          <div className="section-head">
            <h2>
              {route.page === "students"
                ? "Enrolled students"
                : "Consented screen previews"}
            </h2>
            <span>Screen previews expire after 10 seconds</span>
          </div>
          <ScreenMonitor devices={state.devices} previews={previews} session={active} connected={connected} onRevoke={id=>run(()=>api('/devices/'+id+'/revoke',{}))}/>

        </div>
        <div hidden={route.page !== "examinations"}>
          {selected && (
            <ExamProgress
              token={token}
              sessionId={selected}
              onReview={(studentId, sessionId) =>
                navigate("incidents", { studentId, sessionId })
              }
            />
          )}
          <QuestionPapers
            token={token}
            sessions={state.sessions}
            devices={state.devices}
          />
        </div>
        <div hidden={route.page !== "incidents"}>
          <section className="panel" id="review">
            <div className="section-head">
              <div>
                <h2>Event history & review</h2>
                <p>
                  Connection loss is a technical event. All alerts require human
                  judgment.
                </p>
              </div>
              <select
                aria-label="Session history"
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
              >
                <option value="">Select session</option>
                {state.sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.status}
                  </option>
                ))}
              </select>
            </div>
            {!events.length ? (
              <div className="empty">No events in this session.</div>
            ) : (
              <div className="event-list">
                {events
                  .filter(
                    (e) =>
                      !new URLSearchParams(route.query).get("studentId") ||
                      e.device_id ===
                        new URLSearchParams(route.query).get("studentId"),
                  )
                  .map((e) => (
                    <article className="event" key={e.id}>
                      <div>
                        <span
                          className={
                            "badge " + (e.kind === "rule_alert" ? "amber" : "")
                          }
                        >
                          {e.kind.replaceAll("_", " ")}
                        </span>
                        <strong>{e.device_name}</strong>
                        <time>{new Date(e.created_at).toLocaleString()}</time>
                        <p>
                          {e.detail.app ||
                            e.detail.reason ||
                            "Student consent updated"}
                        </p>
                        {e.detail.reason && e.detail.app && (
                          <p>{e.detail.reason}</p>
                        )}
                        {e.review && (
                          <blockquote>Review: {e.review}</blockquote>
                        )}
                      </div>
                      <form
                        onSubmit={(ev) => {
                          ev.preventDefault();
                          const form = ev.target;
                          run(async () => {
                            await api("/events/" + e.id + "/review", {
                              review: new FormData(form).get("review"),
                            });
                            await refresh();
                          });
                        }}
                      >
                        <label className="sr-only" htmlFor={"review-" + e.id}>
                          Teacher review
                        </label>
                        <input
                          id={"review-" + e.id}
                          name="review"
                          required
                          maxLength={2000}
                          placeholder="Add teacher review…"
                          defaultValue={e.review || ""}
                        />
                        <button className="secondary">Save review</button>
                      </form>
                    </article>
                  ))}
              </div>
            )}
          </section>
        </div>
        {route.page === "evidence" && (
          <EvidenceCentre
            token={token}
            revision={proctorRevision}
            devices={state.devices}
            sessions={state.sessions}
            query={route.query}
            onOpenIncident={(id) => {
              setSelectedIncident(id);
              navigate("incidents");
            }}
          />
        )}
        <div hidden={!["live", "incidents", "settings"].includes(route.page)}>
          <LiveProctoring
            mode={
              ["live", "incidents", "settings"].includes(route.page)
                ? route.page
                : "hidden"
            }
            onOpenEvidence={(studentId, sessionId) =>
              navigate("evidence", { studentId, sessionId })
            }
            token={token}
            revision={proctorRevision}
            reviewQuery={route.query}
            onOpenControls={(sessionId) => {
              setSelected(sessionId);
              navigate("examinations");
            }}
            selectedIncident={selectedIncident}
            onCloseIncident={() => setSelectedIncident(null)}
            onPendingCount={setPendingCount}
          />
        </div>
        <p className="privacy">
          Screens are streamed to connected instructors and are not stored.
          Event history stores executable names, consent, connection events, and
          teacher reviews.
        </p>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")).render(
  location.pathname === "/student" ? <StudentExam /> : <App />,
);
