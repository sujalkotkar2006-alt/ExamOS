import React, { useState, useEffect, useRef } from "react";
import { AnswerSync } from "./answerSync.js";
import PdfViewer from "./PdfViewer.jsx";
export default function StudentExam() {
  const [token, setToken] = useState(
      new URLSearchParams(location.hash.slice(1)).has("launch")
        ? ""
        : sessionStorage.getItem("examos-student-token") || "",
    ),
    [data, setData] = useState(null),
    [error, setError] = useState(""),
    [answers, setAnswers] = useState(""),
    [now, setNow] = useState(Date.now()),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(""),
    [pdfEpoch, setPdfEpoch] = useState(0);
  const sync = useRef(null),
    draftKey = useRef(null),
    submitting = useRef(false);
  const clearDrafts = () => {
    for (const key of Object.keys(sessionStorage))
      if (key.startsWith("examos-draft:")) sessionStorage.removeItem(key);
  };
  const persistDraft = () => {
    if (!sync.current || !draftKey.current) return;
    try {
      sessionStorage.setItem(
        draftKey.current,
        JSON.stringify({
          answers: sync.current.latest,
          revision: sync.current.revision,
          expires: sync.current.expires,
        }),
      );
    } catch {
      setSaved(
        "Tab recovery unavailable - keep this page open until the server confirms saving",
      );
    }
  };
  const [focusConsent, setFocusConsent] = useState(false);
  const offset = useRef(0),
    initialized = useRef(false);
  const api = async (path, body, credential = token) => {
    const r = await fetch("/api/student" + path, {
      method: body ? "POST" : "GET",
      signal: AbortSignal.timeout(8000),
      headers: {
        Authorization: "Bearer " + credential,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const x = await r.json();
    if (!r.ok) {
      if (r.status === 401) {
        sessionStorage.removeItem("examos-student-token");
        setToken("");
        setData(null);
        clearDrafts();
        if (sync.current) sync.current.stopped = true;
      }
      throw Object.assign(Error(x.error || "Examination request failed"), {
        status: r.status,
      });
    }
    return x;
  };
  async function refresh() {
    const x = await api("/exam");
    offset.current = new Date(x.serverNow).getTime() - Date.now();
    setData(x);
    if (x.attempt)
      draftKey.current = "examos-draft:" + x.device.id + ":" + x.attempt.id;
    for (const key of Object.keys(sessionStorage)) {
      if (!key.startsWith("examos-draft:")) continue;
      try {
        if (
          JSON.parse(sessionStorage.getItem(key)).expires <=
          Date.now() + offset.current
        )
          sessionStorage.removeItem(key);
      } catch {
        sessionStorage.removeItem(key);
      }
    }
    if (x.attempt?.status === "started" && !initialized.current) {
      const attempt = x.attempt;
      draftKey.current = "examos-draft:" + x.device.id + ":" + attempt.id;
      let draft;
      try {
        draft = JSON.parse(sessionStorage.getItem(draftKey.current));
      } catch {}
      const valid =
        draft &&
        draft.expires > Date.now() + offset.current &&
        typeof draft.answers === "string" &&
        draft.answers.length <= 12000;
      sync.current = new AnswerSync({
        send: api,
        status: setSaved,
        revision: attempt.answer_revision,
        answers: attempt.answers,
        acknowledged: (_, revision, submitted) => {
          if (
            submitted ||
            sync.current.stopped ||
            sync.current.latest === sync.current.accepted
          )
            sessionStorage.removeItem(draftKey.current);
          else persistDraft();
        },
      });
      sync.current.expires = new Date(attempt.deadline_at).getTime();
      setSaved("Response saved");
      if (valid && draft.answers !== attempt.answers) {
        sync.current.edit(draft.answers);
        if (draft.revision !== attempt.answer_revision) {
          sync.current.stopped = true;
          setSaved(
            "Recovered unsent response conflicts with the server. Copy it before choosing Use server response.",
          );
        } else setSaved("Recovered unsent response - saving automatically");
      }
      setAnswers(sync.current.latest);
      initialized.current = true;
    }
    if (
      x.attempt &&
      (["submitted", "cancelled"].includes(x.attempt.status) ||
        new Date(x.attempt.deadline_at) <= new Date(x.serverNow))
    ) {
      if (sync.current) sync.current.stopped = true;
      if (draftKey.current) sessionStorage.removeItem(draftKey.current);
    }
    return x;
  }
  const run = async (fn) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e.message);
      try {
        await refresh();
      } catch {}
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    const code = new URLSearchParams(location.hash.slice(1)).get("launch");
    if (!code) return;
    history.replaceState({}, "", location.pathname);
    sessionStorage.removeItem("examos-student-token");
    clearDrafts();
    setToken("");
    api("/exchange", { code }, "")
      .then((x) => {
        sessionStorage.setItem("examos-student-token", x.token);
        initialized.current = false;
        setToken(x.token);
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!token) return;
    let alive = true;
    refresh().catch((e) => setError(e.message));
    const timer = setInterval(() => {
      if (alive) refresh().catch((e) => setError(e.message));
    }, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [token]);
  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now() + offset.current), 500);
    return () => clearInterval(clock);
  }, []);
  const a = data?.exam,
    x = data?.attempt;
  const isOpen =
    a &&
    a.session_status === "active" &&
    now >= new Date(a.opens_at) &&
    now < new Date(a.closes_at);
  const remaining = x?.deadline_at
    ? Math.max(0, Math.ceil((new Date(x.deadline_at) - now) / 1000))
    : null;
  const paused = x?.status === "started" && !!x?.paused_at;
  const completed = x?.status === "submitted" || x?.status === "cancelled";
  useEffect(() => {
    if (x?.status !== "started" || !isOpen || remaining === 0 || paused) return;
    const preventClose = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", preventClose);
    const send = (category) => {
      if (x.focus_consent) api("/proctor-event", { category }).catch(() => {});
    };
    const blur = () => send("window_blur");
    const fullscreen = () => {
      if (!document.fullscreenElement) send("fullscreen_exit");
    };
    const navigation = (e) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        ["l", "n", "t", "w", "r"].includes(e.key.toLowerCase())
      ) {
        e.preventDefault();
        send("navigation_attempt");
      }
    };
    window.addEventListener("blur", blur);
    document.addEventListener("fullscreenchange", fullscreen);
    window.addEventListener("keydown", navigation);
    return () => {
      window.removeEventListener("beforeunload", preventClose);
      window.removeEventListener("blur", blur);
      document.removeEventListener("fullscreenchange", fullscreen);
      window.removeEventListener("keydown", navigation);
    };
  }, [token, x?.status, x?.focus_consent, isOpen, remaining === 0, paused]);
  useEffect(() => {
    if (x?.status !== "started" || !isOpen || remaining === 0 || paused) return;
    const tick = () => {
      if (sync.current && !sync.current.stopped)
        sync.current.flush(submitting.current).then((done) => {
          if (sync.current.stopped) {
            submitting.current = false;
            setBusy(false);
            if (done) refresh().catch((e) => setError(e.message));
          }
        });
    };
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [token, x?.status, isOpen, remaining === 0, paused]);
  useEffect(() => {
    if (remaining === 0 || completed) {
      if (sync.current) sync.current.stopped = true;
      if (draftKey.current) sessionStorage.removeItem(draftKey.current);
      submitting.current = false;
      setBusy(false);
    }
  }, [remaining === 0, completed]);
  useEffect(() => {
    if (paused) {
      submitting.current = false;
      setBusy(false);
      if (sync.current?.pending?.path.endsWith("submit"))
        sync.current.pending = null;
    } else if (sync.current) sync.current.next = 0;
  }, [paused]);
  return (
    <main className="student-exam">
      <header>
        <div>
          <div className="brand">◉ ExamOS</div>
          <span className="eyebrow">STUDENT EXAMINATION</span>
          <h1>{a?.title || "Your examination"}</h1>
        </div>
        <span className="badge">
          {data?.device.name || "Enrolled device access"}
        </span>
      </header>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!token && (
        <p>
          Open this page using <strong>Open examination page</strong> in your
          connected ExamOS desktop agent. Links are one use and expire after one
          minute.
        </p>
      )}
      {a && (
        <>
          <section className="stats">
            <article>
              <span>SUBJECT</span>
              <strong className="status">{a.subject}</strong>
            </article>
            <article>
              <span>TOTAL MARKS</span>
              <strong>{a.total_marks}</strong>
            </article>
            <article>
              <span>DURATION</span>
              <strong className="status">
                {a.duration_seconds / 60} minutes
              </strong>
            </article>
          </section>
          <section className="panel">
            <h2>{a.session_name}</h2>
            <p>
              Opens {new Date(a.opens_at).toLocaleString()} · Closes{" "}
              {new Date(a.closes_at).toLocaleString()}
            </p>
            <p>
              Screen monitoring remains controlled by your desktop agent’s
              separate consent and visible indicator.
            </p>
            <p>
              LIMITED examination environment: ordinary browser navigation is
              discouraged; Windows application switching and security shortcuts
              remain available. Camera access requires separate consent in the
              visible desktop agent.
            </p>
            <p>
              With your separate evidence consent, detector events and
              teacher-requested camera checks can include a webcam snapshot and
              a short silent clip for teacher review. Clips use a temporary
              memory buffer; no audio or continuous recording is stored. You may
              stop monitoring at any time from the visible agent.
            </p>
            {x?.status !== "started" && !completed && (
              <label>
                <input
                  type="checkbox"
                  checked={focusConsent}
                  onChange={(e) => setFocusConsent(e.target.checked)}
                />{" "}
                I consent to recording examination window focus loss,
                full-screen exit and navigation attempts. No typed text or keys
                are recorded.
              </label>
            )}
            {x?.status === "started" && (
              <p aria-live="polite">
                Examination window event monitoring:{" "}
                {x.focus_consent ? "ACTIVE — consented" : "OFF"}.{" "}
                <button
                  className="secondary"
                  onClick={() => run(() => api("/stop-monitoring", {}))}
                >
                  Stop all monitoring
                </button>
              </p>
            )}
            {paused && (
              <div className="notice" role="status">
                <strong>
                  Your exam has been paused for invigilator review.
                </strong>
                <p>Reason: {x.control_reason}</p>
                <p>
                  The deadline continues. Your unsent response is retained in
                  this tab. Editing, saving, submitting and further paper access
                  are paused. Existing monitoring choices remain under your
                  control.
                </p>
              </div>
            )}
            {completed ? (
              <div className="notice" role="status">
                <strong>
                  {x.submission_reason === "teacher_ended"
                    ? "Your exam has been ended by the invigilator"
                    : x.status === "submitted"
                      ? "Examination submitted"
                      : "Examination closed before you started"}
                </strong>
                <p>
                  {x.submitted_at && new Date(x.submitted_at).toLocaleString()}{" "}
                  · {x.submission_reason}
                </p>
                <p>Your submission status is recorded. Receipt: {x.id}</p>
                {x.submission_reason === "teacher_ended" && (
                  <p>
                    Reason: {x.control_reason}. Only answers acknowledged by the
                    server were retained.
                  </p>
                )}
              </div>
            ) : !isOpen ? (
              <p className="notice">
                {a.session_status === "ended" || now >= new Date(a.closes_at)
                  ? "The examination has ended."
                  : "The examination has not opened yet."}
              </p>
            ) : (
              <>
                <div className="section-head">
                  <button
                    disabled={busy || x?.status === "started"}
                    onClick={() =>
                      run(() => api("/exam/start", { focusConsent }))
                    }
                  >
                    {paused
                      ? "Examination paused"
                      : x?.status === "started"
                        ? "Examination in progress"
                        : "Start examination"}
                  </button>
                  {x?.status === "started" && (
                    <strong role="timer" aria-label="Time remaining">
                      {Math.floor(remaining / 60)}:
                      {String(remaining % 60).padStart(2, "0")} remaining
                    </strong>
                  )}
                </div>
                {!paused && (
                  <PdfViewer
                    key={pdfEpoch}
                    url="/api/student/exam/pdf"
                    token={token}
                  />
                )}
                <button
                  className="secondary"
                  disabled={paused}
                  onClick={() => setPdfEpoch((p) => p + 1)}
                >
                  Reload question paper
                </button>
                {x?.status === "started" && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      submitting.current = true;
                      setBusy(true);
                    }}
                  >
                    <label className="response-label">
                      Your text response (optional)
                      <textarea
                        readOnly={paused || busy || sync.current?.stopped}
                        value={answers}
                        maxLength={12000}
                        onChange={(e) => {
                          setAnswers(e.target.value);
                          sync.current?.edit(e.target.value);
                          persistDraft();
                        }}
                        rows={8}
                      />
                    </label>
                    <p role="status">{saved}</p>
                    <p>
                      Unsent responses are kept only in this browser tab until
                      the deadline. Closing the tab clears recovery. They are
                      not submitted after time expires.
                    </p>
                    {sync.current?.stopped && (
                      <button
                        type="button"
                        onClick={() => {
                          if (
                            !window.confirm(
                              "Replace the visible unsent response with the server response? Copy any unsent text first.",
                            )
                          )
                            return;
                          sync.current = null;
                          initialized.current = false;
                          submitting.current = false;
                          setBusy(false);
                          if (draftKey.current)
                            sessionStorage.removeItem(draftKey.current);
                          refresh().catch((e) => setError(e.message));
                        }}
                      >
                        Use server response
                      </button>
                    )}
                    <button
                      disabled={
                        paused ||
                        busy ||
                        remaining === 0 ||
                        sync.current?.stopped
                      }
                    >
                      Submit examination
                    </button>
                  </form>
                )}
              </>
            )}
          </section>
        </>
      )}
    </main>
  );
}
