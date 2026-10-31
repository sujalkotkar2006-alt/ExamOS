import { apiFetch } from "./backend.js";
import React, { useEffect, useState } from "react";
function cameraCheckBlockReason(d) {
  if (!d.online) return 'Reconnect this enrolled device first.';
  if (!d.examination_id || d.exam_status !== 'started') return 'Start this student’s assigned examination first. Ended or expired exams cannot capture evidence.';
  if (!d.cameraConsent || d.cameraStatus !== 'active') return 'The student must explicitly start the camera and wait for CAMERA ACTIVE.';
  if (!d.snapshots) return 'The student must separately allow snapshots before a camera check.';
  return '';
}
export default function LiveProctoring({
  token,
  revision,
  selectedIncident,
  onCloseIncident,
  onPendingCount,
  mode = "all",
  reviewQuery = "",
  onOpenControls,
  onOpenEvidence,
}) {
  const [data, setData] = useState(null),
    [error, setError] = useState(""),
    [evidence, setEvidence] = useState(null),
    [details, setDetails] = useState(null);
  const [deleteEvent, setDeleteEvent] = useState(null);
  const [checkMessage, setCheckMessage] = useState(""),
    [checkRequestId, setCheckRequestId] = useState(null),
    [historyOffset, setHistoryOffset] = useState(0),
    [historyTotal, setHistoryTotal] = useState(0);
  useEffect(() => setHistoryOffset(0), [reviewQuery]);
  useEffect(() => {
    if (!["incidents", "all"].includes(mode)) {
      setDetails(null);
      setEvidence(null);
    }
  }, [mode]);
  const api = async (path, body) => {
    const r = await apiFetch("/api/proctor" + path, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!r.ok)
      throw Error((await r.json()).error || "Proctoring request failed");
    return r.json();
  };
  const refresh = () =>
    api("/live")
      .then(async (x) => {
        if (mode === "incidents") {
          const filters = new URLSearchParams(reviewQuery);
          const history = await api(
            "/incidents?offset=" + historyOffset + "&" + filters,
          );
          x.events = history.events;
          setHistoryTotal(history.total);
        }
        setData(x);
        const check = x.devices
          .map((d) => d.lastCameraCheck)
          .find((c) => c?.id === checkRequestId);
        if (check && check.status !== "queued")
          setCheckMessage(
            check.status === "captured"
              ? "Camera check saved a real snapshot. Open student evidence or the Evidence Centre."
              : check.error || "Camera check " + check.status,
          );
        onPendingCount?.(x.pendingCount);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [token, revision, mode, historyOffset, checkRequestId, reviewQuery]);
  useEffect(
    () => () => {
      if (evidence) URL.revokeObjectURL(evidence.url);
    },
    [evidence],
  );
  useEffect(() => {
    if (selectedIncident)
      api("/events/" + selectedIncident)
        .then(setDetails)
        .catch((e) => setError(e.message));
  }, [selectedIncident, token]);

  useEffect(() => {
    if (!details) return;
    let active = true;
    const timer = setInterval(
      () =>
        api("/events/" + details.id)
          .then((value) => {
            if (active) setDetails(value);
          })
          .catch(() => {}),
      2000,
    );
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [details?.id, token]);
  const run = async (fn) => {
    try {
      setError("");
      await fn();
      await refresh();
    } catch (e) {
      setError(e.message);
    }
  };
  async function view(event) {
    const r = await apiFetch("/api/proctor/events/" + event.id + "/evidence", {
      headers: { Authorization: "Bearer " + token },
    });
    if (!r.ok) throw Error("Evidence unavailable or expired");
    setEvidence({
      id: event.id,
      url: URL.createObjectURL(await r.blob()),
      name: event.device_name,
    });
  }
  return (
    <section
      className={"panel proctor-mode-" + mode}
      id="live-proctoring"
      aria-label="Live Proctoring"
    >
      <h2>
        {mode === "incidents"
          ? "Detected incidents"
          : mode === "settings"
            ? "Capture & retention policy"
            : "Student camera status"}
      </h2>
      <p>
        Object observations and technical events require teacher review.
        Detection errors and disconnections are never a finding of misconduct.
        No gaze, attention, emotion, or identity analysis.
      </p>
      {mode === "incidents" && reviewQuery && (
        <p>
          Filtered student/session review.{" "}
          <a href="#/incidents">Show all incidents</a>
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {checkMessage && (
        <p className="notice" role="status">
          {checkMessage}
        </p>
      )}
      {data && (
        <>
          <div className="proctor-settings">
            <label>
              Evidence retention (days, 1–30){" "}
              <input
                aria-label="Evidence retention days"
                type="number"
                min="1"
                max="30"
                defaultValue={data.settings.retentionDays}
                key={data.settings.retentionDays}
                onBlur={(e) => {
                  if (Number(e.target.value) !== data.settings.retentionDays)
                    run(() =>
                      api("/settings", {
                        retentionDays: Number(e.target.value),
                      }),
                    );
                }}
              />
            </label>
            <p>
              Only separately consented event snapshots are stored. Shorter
              retention applies immediately; longer retention requires fresh
              camera consent. Silent event clips require a separate opt-in. No
              continuous webcam footage is permanently stored.
            </p>
            <div className="evidence-settings">
              <label>
                Incident cooldown (seconds, 10–300)
                <input
                  aria-label="Incident cooldown seconds"
                  type="number"
                  min="10"
                  max="300"
                  defaultValue={data.settings.cooldownSeconds}
                  key={"cooldown" + data.settings.cooldownSeconds}
                  onBlur={(e) => {
                    if (
                      Number(e.target.value) !== data.settings.cooldownSeconds
                    )
                      run(() =>
                        api("/settings", {
                          retentionDays: data.settings.retentionDays,
                          cooldownSeconds: Number(e.target.value),
                        }),
                      );
                  }}
                />
              </label>
              <label>
                Event clip duration (seconds, 4–20)
                <input
                  aria-label="Event clip duration seconds"
                  type="number"
                  min="4"
                  max="20"
                  defaultValue={data.settings.clipSeconds}
                  key={"clip" + data.settings.clipSeconds}
                  onBlur={(e) => {
                    if (Number(e.target.value) !== data.settings.clipSeconds)
                      run(() =>
                        api("/settings", {
                          retentionDays: data.settings.retentionDays,
                          clipSeconds: Number(e.target.value),
                        }),
                      );
                  }}
                />
              </label>
            </div>
            <p>
              New camera consent uses these capture settings. A continuous
              detection creates one incident; it must clear for two seconds
              before rearming, and the cooldown must also elapse.
            </p>
          </div>
          {["live", "all"].includes(mode) && (
            <div className="device-grid">
              {data.devices
                .filter((d) => !d.revoked)
                .sort((a, b) => Number(b.online) - Number(a.online))
                .map((d) => (
                  <article className="proctor-device" key={d.id}>
                    <h3>{d.name}</h3>
                    <p className="small-id">
                      Student ID: {d.id}
                      <br />
                      Examination ID: {d.examination_id || "Not started"}
                    </p>
                    <p>
                      {d.online
                        ? "Connected"
                        : "Disconnected — technical status only"}
                    </p>
                    {d.latestSnapshot ? (
                      <div className="latest-snapshot">
                        <span className="eyebrow">
                          LATEST SAVED SNAPSHOT · NOT A LIVE VIDEO
                        </span>
                        <PrivateMedia
                          token={token}
                          evidenceId={d.latestSnapshot.id}
                        />
                        <p>
                          {d.latestSnapshot.category.replaceAll("_", " ")} ·{" "}
                          {new Date(
                            d.latestSnapshot.captured_at,
                          ).toLocaleString()}
                        </p>
                      </div>
                    ) : (
                      <div className="empty small-empty">
                        No uploaded snapshot. Camera access and snapshot consent
                        are separate.
                      </div>
                    )}
                    <div className="card-actions">
                      <button
                        className="secondary"
                        disabled={!!cameraCheckBlockReason(d)}
                        title={cameraCheckBlockReason(d) || 'Capture a new consented camera snapshot'}
                        onClick={() =>
                          run(async () => {
                            const r = await api(
                              "/devices/" + d.id + "/camera-check",
                              {},
                            );
                            setCheckMessage(r.message);
                            setCheckRequestId(r.requestId);
                          })
                        }
                      >
                        Request camera check
                      </button>
                      <button
                        className="text-button"
                        onClick={() =>
                          onOpenEvidence?.(
                            d.id,
                            d.latestSnapshot?.session_id || d.session_id,
                          )
                        }
                      >
                        Open student evidence
                      </button>
                    </div>
                    {cameraCheckBlockReason(d) && <p className="check-result">Camera check unavailable: {cameraCheckBlockReason(d)}</p>}
                    {d.lastCameraCheck && (
                      <p className="check-result">
                        Camera check: {d.lastCameraCheck.status}
                        {d.lastCameraCheck.error
                          ? " — " + d.lastCameraCheck.error
                          : ""}
                      </p>
                    )}
                    <p>
                      <strong>Camera: {d.cameraStatus}</strong> ·{" "}
                      {d.snapshots ? "Snapshots consented" : "No snapshots"} ·
                      Clips: {d.cameraConsent && d.clips ? "consented" : "off"}
                    </p>
                    <p>
                      Examination: {d.exam_status || "not started"} · Window
                      events: {d.focus_consent ? "consented" : "off"}
                    </p>
                    <p>
                      Environment:{" "}
                      {d.lockdownMode === "limited_edge"
                        ? "LIMITED — Edge kiosk"
                        : d.lockdownMode === "browser_only"
                          ? "LIMITED — browser"
                          : d.lockdownMode.replaceAll("_", " ")}
                      . Windows lockdown is not verified.
                    </p>
                  </article>
                ))}
            </div>
          )}
          <div className="proctor-incidents">
            <h3>Evidence and incident review</h3>
            <p className="pending-count" role="status">
              {data.pendingCount} pending observations — teacher review required
            </p>
            {!data.events.length && <p>No proctoring observations recorded.</p>}
            {[...data.events]
              .sort(
                (a, b) =>
                  Number(b.review_status === "pending") -
                  Number(a.review_status === "pending"),
              )
              .map((e) => (
                <article
                  className={
                    "proctor-event " +
                    (e.review_status === "pending" ? "incident-pending" : "")
                  }
                  key={e.id}
                  data-incident-id={e.id}
                >
                  <h4>
                    {e.category === "camera_check"
                      ? "Camera check"
                      : e.category.startsWith("camera_")
                        ? "Technical observation"
                        : "Potential Examination Incident"}
                  </h4>
                  <strong>{e.label}</strong> · {e.device_name} ·{" "}
                  {e.session_name}
                  <br />
                  <time>{new Date(e.observed_at).toLocaleString()}</time> ·{" "}
                  <span className="badge">{e.review_status}</span>
                  <p>{e.detail.interpretation}</p>
                  <p>
                    Student/device ID: {e.device_id}
                    <br />
                    Examination ID: {e.attempt_id || "Unavailable"} · Session:{" "}
                    {e.session_id}
                    <br />
                    Detection confidence:{" "}
                    {typeof e.detail.confidence === "number"
                      ? (e.detail.confidence * 100).toFixed(1) + "%"
                      : "Not available for this event"}{" "}
                    · Video: {e.has_clip ? "available" : e.clip_status}
                  </p>
                  <button
                    className="secondary"
                    onClick={() =>
                      run(async () => setDetails(await api("/events/" + e.id)))
                    }
                  >
                    Open incident details
                  </button>
                  {e.has_evidence && (
                    <>
                      <button
                        className="secondary"
                        onClick={() => run(() => view(e))}
                      >
                        View evidence
                      </button>{" "}
                      <button
                        className="secondary"
                        onClick={() => setDeleteEvent(e)}
                      >
                        Delete evidence
                      </button>
                      <p>
                        Snapshot expires{" "}
                        {new Date(e.evidence_expires_at).toLocaleString()}
                      </p>
                    </>
                  )}
                  <form
                    onSubmit={(ev) => {
                      ev.preventDefault();
                      const f = new FormData(ev.currentTarget);
                      run(() =>
                        api("/events/" + e.id + "/review", {
                          status: f.get("status"),
                          note: f.get("note"),
                        }),
                      );
                    }}
                  >
                    <label>
                      Review note{" "}
                      <input
                        name="note"
                        aria-label={"Review note " + e.device_name}
                        defaultValue={e.review_note}
                        maxLength="2000"
                      />
                    </label>
                    <label>
                      Decision{" "}
                      <select
                        name="status"
                        defaultValue={
                          e.review_status === "pending"
                            ? "reviewed"
                            : e.review_status
                        }
                      >
                        <option value="reviewed">Reviewed</option>
                        <option value="false_positive">False Positive</option>
                        <option value="requires_investigation">
                          Requires Investigation
                        </option>
                        <option value="dismissed">Ignore / dismiss</option>
                      </select>
                    </label>
                    <button className="secondary">
                      Save observation review
                    </button>
                  </form>
                </article>
              ))}
            {mode === "incidents" && (
              <div className="pagination">
                <button
                  className="secondary"
                  disabled={!historyOffset}
                  onClick={() =>
                    setHistoryOffset(Math.max(0, historyOffset - 50))
                  }
                >
                  Previous incidents
                </button>
                <span>{historyTotal} detected events</span>
                <button
                  className="secondary"
                  disabled={historyOffset + 50 >= historyTotal}
                  onClick={() => setHistoryOffset(historyOffset + 50)}
                >
                  Next incidents
                </button>
              </div>
            )}
          </div>
        </>
      )}
      {details && (
        <div
          role="dialog"
          aria-label="Incident details"
          aria-modal="true"
          className="evidence-dialog incident-details"
        >
          <h3>Potential Examination Incident — {details.device_name}</h3>
          <p>
            {details.label} · {new Date(details.observed_at).toLocaleString()}
          </p>
          <button
            className="secondary"
            onClick={() => {
              setDetails(null);
              onCloseIncident?.();
              onOpenControls?.(details.session_id);
            }}
          >
            Open examination progress and manual controls
          </button>
          <p>
            Student ID: {details.device_id}
            <br />
            Examination ID: {details.attempt_id}
            <br />
            Session ID: {details.session_id}
          </p>
          <p>
            Confidence:{" "}
            {typeof details.detail.confidence === "number"
              ? (details.detail.confidence * 100).toFixed(1) + "%"
              : "Not available — no confidence of absence is inferred"}
          </p>
          {details.detail.app && (
            <p>Observed executable: {details.detail.app}</p>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {checkMessage && <p role="status">{checkMessage}</p>}
          <button
            className="secondary"
            onClick={() =>
              run(async () => {
                const result = await api(
                  "/devices/" + details.device_id + "/camera-check",
                  { incidentId: details.id },
                );
                setCheckMessage(
                  result.message +
                    " This camera check is linked to the selected incident; it is captured after the event.",
                );
              })
            }
          >
            Request consented camera snapshot for this incident
          </button>
          <p>
            A camera snapshot requires an active camera and separate snapshot
            consent. This does not save the student’s screen or prove
            misconduct.
          </p>
          {details.relatedEvidence?.map((asset) => (
            <div key={asset.id}>
              <p>
                Linked teacher-requested {asset.kind}, captured{" "}
                {new Date(asset.captured_at).toLocaleString()} after the
                original event.
              </p>
              {asset.status === "available" &&
              new Date(asset.expires_at) > new Date() ? (
                <PrivateMedia
                  token={token}
                  evidenceId={asset.id}
                  video={asset.kind === "clip"}
                />
              ) : (
                <p>Linked evidence is deleted or expired.</p>
              )}
            </div>
          ))}
          {details.has_evidence ? (
            <PrivateMedia token={token} id={details.id} />
          ) : (
            <p>Snapshot not available, not consented, deleted or expired.</p>
          )}
          {details.has_clip ? (
            <PrivateMedia token={token} id={details.id} video />
          ) : (
            <p>
              Video: {details.clip_status}. Pending clips may be discarded if
              consent or the examination ends.
            </p>
          )}
          {details.clip_metadata && (
            <p>
              Silent clip: {details.clip_metadata.durationSeconds.toFixed(2)}s;{" "}
              {details.clip_metadata.preEventSeconds.toFixed(2)}s before /{" "}
              {details.clip_metadata.postEventSeconds.toFixed(2)}s after
              detection. {details.clip_metadata.frames} actual frames. No audio.
            </p>
          )}
          <h4>Incident timeline</h4>
          <ol>
            <li>
              {new Date(details.observed_at).toLocaleString()} — Original
              detection: {details.label}
            </li>
            {details.timeline
              .filter((t) => t.kind !== "proctor_observation")
              .map((t, i) => (
                <li key={i}>
                  {new Date(t.created_at).toLocaleString()} — {t.kind}:{" "}
                  {t.detail.status || ""} {t.detail.note || ""}
                </li>
              ))}
          </ol>
          <h4>Review history (original detection is preserved)</h4>
          {!details.reviews.length && <p>No reviews yet.</p>}
          {details.reviews.map((r) => (
            <p key={r.id}>
              {new Date(r.created_at).toLocaleString()} · {r.status}:{" "}
              {r.comment}
            </p>
          ))}
          <form
            onSubmit={(ev) => {
              ev.preventDefault();
              const f = new FormData(ev.currentTarget);
              run(async () => {
                await api("/events/" + details.id + "/review", {
                  status: f.get("status"),
                  note: f.get("note"),
                });
                setDetails(await api("/events/" + details.id));
              });
            }}
          >
            <label>
              Incident review comment
              <input name="note" maxLength="2000" required />
            </label>
            <label>
              Incident review status
              <select name="status">
                <option value="reviewed">Reviewed</option>
                <option value="false_positive">False Positive</option>
                <option value="requires_investigation">
                  Requires Investigation
                </option>
              </select>
            </label>
            <button>Save incident review</button>
          </form>
          <button
            className="secondary"
            onClick={() => {
              setDetails(null);
              onCloseIncident?.();
            }}
          >
            Close incident details
          </button>
        </div>
      )}
      {deleteEvent && (
        <div
          role="alertdialog"
          aria-label="Confirm incident evidence deletion"
          className="evidence-dialog"
        >
          <h2>Delete this incident’s snapshot and video?</h2>
          <p>The original incident and review history will remain.</p>
          {error && <p role="alert">{error}</p>}
          <button
            className="danger"
            onClick={() =>
              run(async () => {
                await api("/events/" + deleteEvent.id + "/delete-evidence", {});
                if (evidence?.id === deleteEvent.id) setEvidence(null);
                setDeleteEvent(null);
              })
            }
          >
            Confirm incident evidence deletion
          </button>
          <button className="secondary" onClick={() => setDeleteEvent(null)}>
            Cancel deletion
          </button>
        </div>
      )}
      {evidence && (
        <div
          role="dialog"
          aria-label="Protected event evidence"
          className="evidence-dialog"
        >
          <h3>Event snapshot — {evidence.name}</h3>
          <img src={evidence.url} alt="Consented event snapshot" />
          <button onClick={() => setEvidence(null)}>Close evidence</button>
        </div>
      )}
    </section>
  );
}

export function PrivateMedia({ token, id, video = false, evidenceId }) {
  const [url, setUrl] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    let objectUrl = "",
      alive = true;
    const controller = new AbortController();
    setUrl("");
    setError("");
    apiFetch(
      evidenceId
        ? "/api/proctor/evidence/" + evidenceId + "/content"
        : "/api/proctor/events/" + id + (video ? "/clip" : "/evidence"),
      {
        headers: { Authorization: "Bearer " + token },
        signal: controller.signal,
      },
    )
      .then(async (r) => {
        if (!r.ok) {
          const x = await r.json().catch(() => ({}));
          throw Error(x.error || "Evidence unavailable or expired");
        }
        objectUrl = URL.createObjectURL(await r.blob());
        if (alive) setUrl(objectUrl);
        else URL.revokeObjectURL(objectUrl);
      })
      .catch((e) => {
        if (alive && e.name !== "AbortError") setError(e.message);
      });
    return () => {
      alive = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [token, id, video, evidenceId]);
  if (error) return <p role="alert">{error}</p>;
  if (!url) return <p>Loading protected {video ? "clip" : "snapshot"}…</p>;
  return video ? (
    <video
      src={url}
      controls
      preload="metadata"
      aria-label="Silent incident clip"
    />
  ) : (
    <img
      className="incident-snapshot"
      src={url}
      alt="Consented incident snapshot"
    />
  );
}
