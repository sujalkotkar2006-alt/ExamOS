import { apiFetch } from "./backend.js";
import React, { useRef, useState } from "react";

export default function AttemptControls({
  token,
  sessionId,
  attempt,
  onChanged,
}) {
  const [action, setAction] = useState(""),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const pending = useRef(null);
  if (
    !attempt.attempt_id ||
    !["opened", "started"].includes(attempt.status) ||
    attempt.revoked
  )
    return null;
  const execute = async () => {
    setBusy(true);
    setMessage("");
    const body = pending.current || {
      action,
      reason: reason.trim(),
      commandId: crypto.randomUUID(),
    };
    pending.current = body;
    try {
      const response = await apiFetch(
        `/api/sessions/${sessionId}/attempts/${attempt.attempt_id}/control`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(8000),
        },
      );
      const data = await response.json();
      if (!response.ok) {
        if (response.status < 500) pending.current = null;
        throw Error(data.error || "Control failed");
      }
      setMessage(`${body.action} applied. Receipt: ${data.receipt.id}`);
      pending.current = null;
      setAction("");
      setReason("");
      onChanged?.();
    } catch (e) {
      setMessage(
        e.message + (pending.current ? " Retry uses the same command ID." : ""),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="attempt-controls">
      <div className="card-actions">
        {attempt.status === "started" && (
          <button
            className="secondary"
            onClick={() => {
              if (!pending.current)
                setAction(attempt.paused_at ? "resume" : "pause");
            }}
          >
            {attempt.paused_at ? "Resume exam" : "Pause exam"}
          </button>
        )}
        <button
          className="danger"
          onClick={() => {
            if (!pending.current) setAction("end");
          }}
        >
          End this exam
        </button>
      </div>
      {action && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            execute();
          }}
        >
          <strong>
            {action === "end"
              ? "End this student’s attempt?"
              : action === "pause"
                ? "Pause this student’s attempt?"
                : "Resume this student’s attempt?"}
          </strong>
          <p>
            The deadline continues during a pause. Pausing blocks examination
            answers and further paper fetches; it does not lock the computer or
            change monitoring consent. Ending preserves only acknowledged
            answers and cannot be undone here.
          </p>
          <label>
            Control reason for {attempt.name}
            <input
              required
              maxLength={1000}
              value={reason}
              disabled={busy || !!pending.current}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <button disabled={busy || !reason.trim()}>
            {busy ? "Applying…" : `Confirm ${action}`}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy || !!pending.current}
            onClick={() => {
              setAction("");
              setReason("");
            }}
          >
            Cancel
          </button>
        </form>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
