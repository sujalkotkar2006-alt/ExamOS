import { apiFetch } from "./backend.js";
import React, { useState, useEffect } from "react";
import AttemptControls from "./AttemptControls.jsx";
import PdfViewer from "./PdfViewer.jsx";
export function ExamProgress({ token, sessionId, onReview }) {
  const [data, setData] = useState(null),
    [error, setError] = useState(""),
    [now, setNow] = useState(Date.now()),
    [revision, setRevision] = useState(0),
    [flaggedOnly, setFlaggedOnly] = useState(false);
  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    async function load() {
      try {
        const r = await apiFetch("/api/sessions/" + sessionId + "/exam-status", {
          headers: { Authorization: "Bearer " + token },
        });
        const x = await r.json();
        if (!r.ok) throw Error(x.error);
        if (alive) {
          setData(x ? { ...x, clientReceivedAt: Date.now() } : null);
          setError("");
        }
      } catch (e) {
        if (alive) setError(e.message);
      }
    }
    load();
    const poll = setInterval(load, 2000),
      clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [token, sessionId, revision]);
  return (
    <section className="panel" id="exam-progress">
      <h2>Student examination progress</h2>
      {error && <p className="error">{error}</p>}
      {!data ? (
        <p>No question paper assigned to this session.</p>
      ) : (
        <>
          <p>
            {data.assignment.title} · {data.assignment.subject} ·{" "}
            {data.assignment.total_marks} marks · Closes{" "}
            {new Date(data.assignment.closes_at).toLocaleString()}
          </p>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={flaggedOnly}
              onChange={(e) => setFlaggedOnly(e.target.checked)}
            />{" "}
            Only students with pending incidents or app alerts
          </label>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Student device</th>
                  <th>Examination status</th>
                  <th>Remaining time</th>
                  <th>Submission</th>
                  <th>Review and manual controls</th>
                </tr>
              </thead>
              <tbody>
                {data.students
                  .filter(
                    (s) =>
                      !flaggedOnly ||
                      s.pending_incidents + s.pending_app_alerts > 0,
                  )
                  .map((s) => (
                    <tr key={s.device_id}>
                      <td>{s.name}</td>
                      <td>
                        <span className="badge">
                          {s.paused_at && s.status === "started"
                            ? "Paused by invigilator"
                            : {
                                not_opened: "Not opened",
                                opened: "Paper opened",
                                started: "Taking examination",
                                submitted: "Submitted",
                                cancelled: "Ended before start",
                              }[s.status]}
                        </span>
                        {s.started_at && (
                          <small>
                            Started{" "}
                            {new Date(s.started_at).toLocaleTimeString()}
                          </small>
                        )}
                      </td>
                      <td>
                        {s.status === "started"
                          ? Math.max(
                              0,
                              s.remainingSeconds -
                                Math.floor(
                                  (now - data.clientReceivedAt) / 1000,
                                ),
                            ) + " seconds"
                          : "—"}
                      </td>
                      <td>
                        {s.submitted_at
                          ? new Date(s.submitted_at).toLocaleString() +
                            " · " +
                            s.submission_reason
                          : "Not submitted"}
                        {s.status === "submitted" && (
                          <details>
                            <summary>View response</summary>
                            <pre className="answer-review">
                              {s.answers || "No text response provided."}
                            </pre>
                          </details>
                        )}
                      </td>
                      <td>
                        <p>
                          {s.pending_incidents} pending incidents;{" "}
                          {s.pending_app_alerts} application alerts
                        </p>
                        <button
                          className="secondary"
                          onClick={() => onReview?.(s.device_id, sessionId)}
                        >
                          Review student incidents and evidence
                        </button>
                        {s.control_reason && (
                          <p>Latest control reason: {s.control_reason}</p>
                        )}
                        <AttemptControls
                          key={sessionId + ":" + s.attempt_id}
                          token={token}
                          sessionId={sessionId}
                          attempt={s}
                          onChanged={() => setRevision((v) => v + 1)}
                        />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          {flaggedOnly &&
            !data.students.some(
              (s) => s.pending_incidents + s.pending_app_alerts > 0,
            ) && (
              <p>
                No students have pending incidents or application alerts in this
                session.
              </p>
            )}
          <details>
            <summary>Manual control audit history</summary>
            {(data.controls || []).map((c) => (
              <p key={c.id}>
                {new Date(c.created_at).toLocaleString()} - {c.actor_email} -{" "}
                {c.action} - {c.reason} - receipt {c.id}
              </p>
            ))}
          </details>
          {!data.students.length && (
            <p>No enrolled devices match this assignment yet.</p>
          )}
        </>
      )}
    </section>
  );
}
export default function QuestionPapers({ token, sessions, devices }) {
  const [papers, setPapers] = useState([]),
    [audit, setAudit] = useState([]),
    [preview, setPreview] = useState(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [selectedPaper, setSelectedPaper] = useState(""),
    [allDevices, setAllDevices] = useState(true);
  const api = async (path, body) => {
    const form = body instanceof FormData;
    const r = await apiFetch("/api" + path, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: "Bearer " + token,
        ...(!form ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: form ? body : JSON.stringify(body) } : {}),
    });
    const x = await r.json();
    if (!r.ok) throw Error(x.error || "Request failed");
    return x;
  };
  const load = async () => {
    setPapers(await api("/papers"));
    setAudit(await api("/paper-audit"));
  };
  const run = async (fn) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [token]);
  return (
    <section className="panel" id="question-papers">
      <h2>Question Papers</h2>
      <p>
        Private PDF library · Assign to an active session, with a
        server-enforced examination window.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <form
        className="paper-upload"
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const body = new FormData(form);
          run(async () => {
            await api("/papers", body);
            form.reset();
            setNotice("Question paper uploaded.");
          });
        }}
      >
        <label>
          Paper title
          <input name="title" maxLength={150} required />
        </label>
        <label>
          Subject
          <input name="subject" maxLength={120} required />
        </label>
        <label>
          Total marks
          <input name="totalMarks" type="number" min="1" max="10000" required />
        </label>
        <label>
          Exam duration (minutes)
          <input
            name="durationMinutes"
            type="number"
            min="1"
            max="1440"
            required
          />
        </label>
        <label>
          Question paper PDF
          <input
            name="pdf"
            type="file"
            accept="application/pdf,.pdf"
            required
          />
        </label>
        <button disabled={busy}>Upload question paper</button>
      </form>
      <div className="paper-library">
        {papers.length === 0 ? (
          <p>No question papers uploaded.</p>
        ) : (
          papers.map((p) => (
            <article className="paper-row" key={p.id}>
              <div>
                <strong>{p.title}</strong>
                <p>
                  {p.subject} · {p.total_marks} marks ·{" "}
                  {p.duration_seconds / 60} minutes · {p.page_count} pages
                </p>
              </div>
              <button className="secondary" onClick={() => setPreview(p)}>
                Preview PDF
              </button>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await api("/papers/" + p.id + "/delete", {});
                    if (preview?.id === p.id) setPreview(null);
                    setNotice(
                      "Paper deleted from the library. Audit history is retained.",
                    );
                  })
                }
              >
                Delete {p.title}
              </button>
            </article>
          ))
        )}
      </div>
      {preview && (
        <div className="paper-preview">
          <div className="section-head">
            <h3>Preview: {preview.title}</h3>
            <button className="secondary" onClick={() => setPreview(null)}>
              Close PDF preview
            </button>
          </div>
          <PdfViewer url={"/api/papers/" + preview.id + "/pdf"} token={token} />
        </div>
      )}
      <h3>Assign a question paper</h3>
      <form
        className="paper-upload"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          run(async () => {
            await api("/sessions/" + f.get("sessionId") + "/paper", {
              paperId: f.get("paperId"),
              deviceIds: allDevices ? null : f.getAll("deviceIds"),
              ...(f.get("opensAt")
                ? { opensAt: new Date(f.get("opensAt")).toISOString() }
                : {}),
              ...(f.get("closesAt")
                ? { closesAt: new Date(f.get("closesAt")).toISOString() }
                : {}),
            });
            setNotice(
              "Paper assigned. Students can open their examination page from the connected agent.",
            );
          });
        }}
      >
        <label>
          Assign paper
          <select
            name="paperId"
            aria-label="Assign paper"
            required
            value={selectedPaper}
            onChange={(e) => setSelectedPaper(e.target.value)}
          >
            <option value="">Choose paper</option>
            {papers.map((p) => (
              <option value={p.id} key={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Examination session
          <select name="sessionId" aria-label="Examination session" required>
            <option value="">Choose active session</option>
            {sessions
              .filter((s) => s.status === "active")
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Opens at (optional)
          <input name="opensAt" type="datetime-local" />
        </label>
        <label>
          Closes at (optional)
          <input name="closesAt" type="datetime-local" />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={allDevices}
            onChange={(e) => setAllDevices(e.target.checked)}
          />{" "}
          All this teacher’s enrolled devices, including later enrollments
        </label>
        {!allDevices && (
          <fieldset>
            <legend>Assigned devices</legend>
            {devices
              .filter((d) => !d.revoked)
              .map((d) => (
                <label className="checkbox-label" key={d.id}>
                  <input type="checkbox" name="deviceIds" value={d.id} />
                  {d.name}
                </label>
              ))}
          </fieldset>
        )}
        <p>
          Defaults: opens now and closes after the paper duration. Starting late
          gives less time. Assignment locks after the first paper opening.
        </p>
        <button disabled={busy}>Assign paper to session</button>
      </form>
      <h3>Paper audit trail</h3>
      <button className="secondary" onClick={() => run(async () => {})}>
        Refresh paper audit
      </button>
      <div className="audit-list">
        {audit.slice(0, 100).map((a) => (
          <p key={a.id}>
            <time>{new Date(a.created_at).toLocaleString()}</time> ·{" "}
            <strong>{a.action.replaceAll("_", " ")}</strong> ·{" "}
            {a.title || "Paper"} {a.device_name && "· " + a.device_name}
          </p>
        ))}
      </div>
    </section>
  );
}
