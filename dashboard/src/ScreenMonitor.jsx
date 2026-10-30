import React, { useEffect, useMemo, useRef, useState } from "react";

function screenState(device, preview, session, connected, now) {
  const age = preview
    ? Math.max(0, now - (preview.receivedAt ?? preview.at))
    : null;
  const authorized =
    connected &&
    !device.revoked &&
    device.online &&
    device.consented &&
    session;
  const fresh = authorized && preview?.sessionId === session.id && age < 10000;
  const label = !connected
    ? "Teacher connection lost"
    : device.revoked
      ? "Revoked"
      : !device.online
        ? "Offline"
        : !session
          ? "No active examination"
          : !device.consented
            ? "Awaiting consent"
            : fresh
              ? "Sharing"
              : preview
                ? "Preview expired"
                : "Waiting for first preview";
  return {
    fresh,
    age,
    label,
    attention: !fresh || device.app === "[unavailable]",
  };
}

export default function ScreenMonitor({
  devices,
  previews,
  session,
  connected,
  onRevoke,
}) {
  const [now, setNow] = useState(Date.now()),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all"),
    [sort, setSort] = useState("attention"),
    [focused, setFocused] = useState(null),
    [badFrames, setBadFrames] = useState({});
  const dialog = useRef(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  const rows = useMemo(
    () =>
      devices.map((device) => {
        const preview = previews[device.id],
          state = screenState(device, preview, session, connected, now);
        const broken = preview && badFrames[device.id] === preview.at;
        return {
          device,
          preview,
          ...state,
          ...(broken
            ? { fresh: false, label: "Preview unavailable", attention: true }
            : {}),
        };
      }),
    [devices, previews, session, connected, now, badFrames],
  );
  const visible = rows
    .filter((row) => {
      const term = search.toLowerCase().trim();
      return (
        (!term ||
          (row.device.name + " " + row.device.id)
            .toLowerCase()
            .includes(term)) &&
        (filter === "all" ||
          (filter === "attention" && row.attention) ||
          (filter === "sharing" && row.fresh) ||
          (filter === "offline" && !row.device.online))
      );
    })
    .sort(
      (a, b) =>
        (sort === "attention"
          ? Number(b.attention) - Number(a.attention)
          : 0) ||
        a.device.name.localeCompare(b.device.name) ||
        a.device.id.localeCompare(b.device.id),
    );
  const selected = rows.find((r) => r.device.id === focused);
  useEffect(() => {
    if (focused && dialog.current && !dialog.current.open)
      dialog.current.showModal();
    if (!focused && dialog.current?.open) dialog.current.close();
  }, [focused]);
  const close = () => setFocused(null);
  const move = (direction) => {
    const index = visible.findIndex((row) => row.device.id === focused);
    if (visible.length)
      setFocused(
        visible[(index + direction + visible.length) % visible.length].device
          .id,
      );
  };
  const freshness = (row) =>
    row.fresh
      ? `Received ${(row.age / 1000).toFixed(1)} seconds ago`
      : "No current screen preview";
  const screen = (row) =>
    row?.fresh ? (
      <img
        alt={"Consented screen of " + row.device.name}
        src={"data:image/jpeg;base64," + row.preview.jpeg}
        onError={() =>
          setBadFrames((old) =>
            old[row.device.id] === row.preview.at
              ? old
              : { ...old, [row.device.id]: row.preview.at },
          )
        }
      />
    ) : (
      <div className="screen-empty" role="status">
        <strong>{row?.label || "Student no longer available"}</strong>
        <p>
          No screen is displayed. Capture requires the student's current session
          consent.
        </p>
      </div>
    );
  return (
    <section aria-label="Live primary screens">
      <div className="screen-filters">
        <label>
          Find student
          <input
            aria-label="Find student"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name or device ID"
          />
        </label>
        <label>
          Screen status
          <select
            aria-label="Screen status"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">All devices</option>
            <option value="attention">Needs attention</option>
            <option value="sharing">Sharing fresh previews</option>
            <option value="offline">Offline</option>
          </select>
        </label>
        <label>
          Order screens
          <select
            aria-label="Order screens"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="attention">Needs attention first</option>
            <option value="name">Student name</option>
          </select>
        </label>
      </div>
      <p className="muted">
        {visible.length} of {devices.length} devices · Primary screen only ·
        Preview age measures receipt, not continuous video. Technical failures
        are not misconduct findings.
      </p>
      <div className="devices">
        {!visible.length && (
          <div className="empty">
            {devices.length
              ? "No students match these filters."
              : "No enrolled devices yet. Create an enrollment code to connect the first student."}
          </div>
        )}
        {visible.map((row) => (
          <article
            className="device"
            key={row.device.id}
            data-device-id={row.device.id}
          >
            <div className="device-head">
              <strong>{row.device.name}</strong>
              <span className="badge">{row.label}</span>
            </div>
            <div className="screen">{screen(row)}</div>
            <p className="screen-age">{freshness(row)}</p>
            <footer>
              <span>
                {row.device.consented
                  ? row.device.app === "[unavailable]"
                    ? "Application metadata unavailable"
                    : row.device.app || "Waiting for application"
                  : "Monitoring stopped"}
              </span>
              <button
                className="text-button"
                onClick={() => setFocused(row.device.id)}
                aria-label={"Inspect screen of " + row.device.name}
              >
                Inspect screen
              </button>
              {!row.device.revoked && (
                <button
                  className="text-button"
                  onClick={() => onRevoke(row.device.id)}
                >
                  Revoke
                </button>
              )}
            </footer>
          </article>
        ))}
      </div>
      <dialog
        ref={dialog}
        className="screen-dialog"
        aria-labelledby="focused-screen-title"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onClose={close}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            move(-1);
          }
          if (event.key === "ArrowRight") {
            event.preventDefault();
            move(1);
          }
        }}
      >
        <div className="section-head">
          <div>
            <h2 id="focused-screen-title">
              {selected?.device.name || "Student unavailable"}
            </h2>
            <p>Live primary-screen preview · {selected?.label}</p>
          </div>
          <button autoFocus onClick={close}>
            Close focused screen
          </button>
        </div>
        <p className="small-id">
          Device: {selected?.device.id} · Examination: {session?.name || "None"}{" "}
          · Session: {session?.id || "None"}
        </p>
        <p>
          {selected ? freshness(selected) : "Student no longer available"} ·{" "}
          {selected?.device.consented
            ? selected.device.app === "[unavailable]"
              ? "Application metadata unavailable"
              : selected.device.app || "Waiting for application"
            : "Monitoring stopped"}
        </p>
        <div className="focused-primary-screen">{screen(selected)}</div>
        <div className="screen-navigation">
          <button disabled={visible.length < 2} onClick={() => move(-1)}>
            Previous student
          </button>
          <span>Use left/right arrows to navigate; Escape closes.</span>
          <button disabled={visible.length < 2} onClick={() => move(1)}>
            Next student
          </button>
        </div>
      </dialog>
    </section>
  );
}
