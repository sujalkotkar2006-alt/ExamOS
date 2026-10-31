import { apiFetch } from "./backend.js";
import React, { useEffect, useState } from "react";
import { PrivateMedia } from "./LiveProctoring.jsx";
const categories = {
  camera_check: "Camera check",
  phone_detected: "Possible mobile phone",
  multiple_people: "Multiple people",
  no_person_detected: "No person detected",
  camera_obstructed: "Camera obstruction",
};
export default function EvidenceCentre({
  token,
  revision,
  devices,
  sessions,
  query = "",
  onOpenIncident,
}) {
  const params = new URLSearchParams(query);
  const [student, setStudent] = useState(params.get("studentId") || ""),
    [session, setSession] = useState(params.get("sessionId") || ""),
    [kind, setKind] = useState(""),
    [category, setCategory] = useState(""),
    [date, setDate] = useState(""),
    [search, setSearch] = useState(""),
    [status, setStatus] = useState("available"),
    [offset, setOffset] = useState(0),
    [data, setData] = useState(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [selected, setSelected] = useState(null),
    [deleting, setDeleting] = useState(null);
  useEffect(() => {
    const p = new URLSearchParams(query);
    setStudent(p.get("studentId") || "");
    setSession(p.get("sessionId") || "");
    setOffset(0);
  }, [query]);
  const load = async (signal) => {
    const p = new URLSearchParams({
      limit: "24",
      offset: String(offset),
      status,
    });
    for (const [k, v] of Object.entries({
      studentId: student,
      sessionId: session,
      kind,
      category,
      search,
    }))
      if (v) p.set(k, v);
    if (date) {
      const start = new Date(date + "T00:00:00"),
        end = new Date(start);
      end.setDate(end.getDate() + 1);
      p.set("from", start.toISOString());
      p.set("to", end.toISOString());
    }
    const r = await apiFetch("/api/proctor/evidence?" + p, {
      headers: { Authorization: "Bearer " + token },
      signal,
    });
    const result = await r.json();
    if (!r.ok) throw Error(result.error || "Evidence listing failed");
    setData(result);
    setError("");
    return result;
  };
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    load(controller.signal)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [
    token,
    revision,
    student,
    session,
    kind,
    category,
    date,
    search,
    status,
    offset,
  ]);
  const change = (setter) => (e) => {
    setter(e.target.value);
    setOffset(0);
  };
  async function remove() {
    try {
      const r = await apiFetch("/api/proctor/evidence/" + deleting.id, {
        method: "DELETE",
        headers: { Authorization: "Bearer " + token },
      });
      const x = await r.json();
      if (!r.ok) throw Error(x.error || "Deletion failed");
      setDeleting(null);
      setSelected(null);
      await load();
    } catch (e) {
      setError(e.message);
    }
  }
  return (
    <section
      className="panel evidence-centre"
      id="evidence-centre"
      aria-label="Evidence Centre"
    >
      <div className="section-head">
        <div>
          <span className="eyebrow">PRIVATE · AUTHENTICATED MEDIA</span>
          <h2>Snapshots &amp; video recordings</h2>
          <p>
            Actual captured snapshots and silent event recordings. Every item
            belongs to an enrolled student and an examination incident.
          </p>
        </div>
        <button
          className="secondary"
          onClick={() => load().catch((e) => setError(e.message))}
        >
          Refresh evidence
        </button>
      </div>
      <div className="evidence-filters">
        <label>
          Student
          <select
            aria-label="Student"
            value={student}
            onChange={change(setStudent)}
          >
            <option value="">All students</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
                {" · " + d.id.slice(0, 8)}
                {d.revoked ? " · revoked" : d.online ? " · connected" : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          Examination
          <select
            aria-label="Examination"
            value={session}
            onChange={change(setSession)}
          >
            <option value="">All examinations</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Evidence type
          <select
            aria-label="Evidence type"
            value={kind}
            onChange={change(setKind)}
          >
            <option value="">Snapshots & videos</option>
            <option value="snapshot">Snapshots</option>
            <option value="clip">Video recordings</option>
          </select>
        </label>
        <label>
          Event category
          <select
            aria-label="Event category"
            value={category}
            onChange={change(setCategory)}
          >
            <option value="">All categories</option>
            {Object.entries(categories).map(([id, name]) => (
              <option value={id} key={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Capture date
          <input
            aria-label="Capture date"
            type="date"
            value={date}
            onChange={change(setDate)}
          />
        </label>
        <label>
          Search student name or ID
          <input
            aria-label="Search student name or ID"
            value={search}
            onChange={change(setSearch)}
            placeholder="Name or enrolled student ID"
          />
        </label>
        <label>
          Availability
          <select
            aria-label="Availability"
            value={status}
            onChange={change(setStatus)}
          >
            <option value="available">Available media</option>
            <option value="all">Include deleted, expired & missing</option>
          </select>
        </label>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading && (
        <p className="muted" role="status">
          Loading evidence…
        </p>
      )}
      {data && (
        <>
          <p className="result-count">
            {data.total} evidence item{data.total === 1 ? "" : "s"} matching
            these filters
          </p>
          {!data.items.length && (
            <div className="empty">
              <h3>No saved evidence matches these filters</h3>
              <p>
                A camera preview is not a saved snapshot or video. During a
                started examination, the student must separately consent to
                snapshots and clips. Use Request Camera Check in Live Proctoring
                to verify a real upload. Deleted test evidence cannot be
                displayed.
              </p>
            </div>
          )}
          <div className="evidence-grid">
            {data.items.map((a) => (
              <article
                className="evidence-card"
                key={a.id}
                data-evidence-id={a.id}
              >
                <div className="evidence-thumbnail">
                  {a.availability === "available" ? (
                    a.kind === "snapshot" ? (
                      <button
                        className="image-open"
                        aria-label={"Enlarge snapshot " + a.student_name}
                        onClick={() => setSelected(a)}
                      >
                        <PrivateMedia token={token} evidenceId={a.id} />
                      </button>
                    ) : (
                      <button
                        className="video-open"
                        onClick={() => setSelected(a)}
                      >
                        <span aria-hidden="true">▶</span> Play actual video
                        recording
                      </button>
                    )
                  ) : (
                    <p className="media-unavailable">
                      Evidence {a.availability}
                    </p>
                  )}
                </div>
                <div className="evidence-caption">
                  <span className="badge">
                    {a.kind === "snapshot" ? "Snapshot" : "Video recording"}
                  </span>
                  <h3>{a.student_name}</h3>
                  <p>
                    {a.session_name} · {a.label}
                  </p>
                  <time dateTime={a.captured_at} title={a.captured_at}>
                    {new Date(a.captured_at).toLocaleString()}
                  </time>
                  {a.kind === "clip" && a.clip_metadata && (
                    <p>
                      Duration: {a.clip_metadata.durationSeconds.toFixed(2)}{" "}
                      seconds · silent
                    </p>
                  )}
                  <p className="small-id">
                    Evidence {a.id}
                    <br />
                    Student {a.student_id}
                    <br />
                    Examination {a.examination_id || "Unavailable"}
                  </p>
                  <div className="card-actions">
                    <button
                      className="text-button"
                      onClick={() => onOpenIncident(a.event_id)}
                    >
                      Related incident
                    </button>
                    <button
                      className="text-button danger-text"
                      disabled={a.availability === "deleted"}
                      onClick={() => setDeleting(a)}
                    >
                      Delete evidence
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
          <div className="pagination">
            <button
              className="secondary"
              disabled={!offset}
              onClick={() => setOffset(Math.max(0, offset - 24))}
            >
              Previous evidence
            </button>
            <span>
              {data.total ? offset + 1 : 0}–{Math.min(offset + 24, data.total)}{" "}
              of {data.total}
            </span>
            <button
              className="secondary"
              disabled={offset + 24 >= data.total}
              onClick={() => setOffset(offset + 24)}
            >
              Next evidence
            </button>
          </div>
        </>
      )}
      {selected && (
        <div
          className="evidence-dialog"
          role="dialog"
          aria-label={
            selected.kind === "snapshot"
              ? "Snapshot viewer"
              : "Video recording viewer"
          }
          aria-modal="true"
        >
          <h2>
            {selected.kind === "snapshot"
              ? "Captured snapshot"
              : "Actual video recording"}{" "}
            — {selected.student_name}
          </h2>
          <p>
            {selected.label} · {new Date(selected.captured_at).toLocaleString()}
          </p>
          <PrivateMedia
            token={token}
            evidenceId={selected.id}
            video={selected.kind === "clip"}
          />
          {selected.kind === "clip" && selected.clip_metadata && (
            <p>
              Actual duration:{" "}
              {selected.clip_metadata.durationSeconds.toFixed(2)} seconds.{" "}
              {selected.clip_metadata.frames} captured frames, no audio.
            </p>
          )}
          <p>
            Evidence ID: {selected.id}
            <br />
            Examination: {selected.examination_id}
            <br />
            Incident: {selected.event_id}
          </p>
          <button onClick={() => setSelected(null)}>
            Close evidence viewer
          </button>
        </div>
      )}
      {deleting && (
        <div
          className="evidence-dialog confirm-dialog"
          role="alertdialog"
          aria-label="Confirm evidence deletion"
          aria-modal="true"
        >
          <h2>
            Delete this{" "}
            {deleting.kind === "snapshot" ? "snapshot" : "video recording"}?
          </h2>
          <p>
            The private media bytes will be deleted. The incident and audit
            history will be retained.
          </p>
          <button className="danger" onClick={remove}>
            Confirm delete evidence
          </button>
          <button className="secondary" onClick={() => setDeleting(null)}>
            Cancel deletion
          </button>
        </div>
      )}
    </section>
  );
}
