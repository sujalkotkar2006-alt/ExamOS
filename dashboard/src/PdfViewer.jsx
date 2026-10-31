import { apiFetch } from "./backend.js";
import React, { useState, useEffect, useRef } from "react";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
GlobalWorkerOptions.workerSrc = workerUrl;
export default function PdfViewer({ url, token, onLoaded }) {
  const [pdf, setPdf] = useState(null),
    [page, setPage] = useState(1),
    [error, setError] = useState(""),
    [ready, setReady] = useState(false);
  const canvas = useRef(null);
  useEffect(() => {
    let disposed = false,
      task;
    setPdf(null);
    setPage(1);
    setError("");
    setReady(false);
    const controller = new AbortController();
    apiFetch(url, {
      headers: { Authorization: "Bearer " + token },
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (r) => {
        if (!r.ok) {
          const x = await r.json();
          throw Error(x.error || "PDF unavailable");
        }
        return new Uint8Array(await r.arrayBuffer());
      })
      .then(async (data) => {
        if (disposed) return;
        task = getDocument({
          data,
          isEvalSupported: false,
          stopAtErrors: true,
          useSystemFonts: true,
        });
        const document = await task.promise;
        if (disposed) {
          document.destroy();
          return;
        }
        setPdf(document);
        onLoaded?.();
      })
      .catch((e) => {
        if (!disposed) setError(e.message);
      });
    return () => {
      disposed = true;
      controller.abort();
      task?.destroy();
    };
  }, [url, token]);
  useEffect(() => {
    if (!pdf || !canvas.current) return;
    let cancelled = false,
      render;
    setReady(false);
    pdf
      .getPage(page)
      .then((p) => {
        if (cancelled) return;
        const view = p.getViewport({ scale: 1.25 });
        const c = canvas.current;
        c.width = view.width;
        c.height = view.height;
        render = p.render({
          canvasContext: c.getContext("2d"),
          viewport: view,
        });
        return render.promise;
      })
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
      render?.cancel();
    };
  }, [pdf, page]);
  return (
    <div className="pdf-viewer" aria-label="Question paper PDF">
      <div className="pdf-tools">
        <button
          className="secondary"
          disabled={!pdf || page <= 1}
          onClick={() => setPage((p) => p - 1)}
        >
          Previous page
        </button>
        <span>{pdf ? `Page ${page} of ${pdf.numPages}` : "Loading PDF…"}</span>
        <button
          className="secondary"
          disabled={!pdf || page >= pdf.numPages}
          onClick={() => setPage((p) => p + 1)}
        >
          Next page
        </button>
      </div>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : (
        <>
          <canvas
            ref={canvas}
            aria-label={"Question paper page " + page}
            data-rendered={ready ? "true" : "false"}
          />
          {ready && <span className="pdf-loaded">PDF page rendered</span>}
        </>
      )}
    </div>
  );
}
