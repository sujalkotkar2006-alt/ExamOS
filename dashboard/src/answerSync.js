// One in-flight write per page. Retries reuse the original revision and ID.
export class AnswerSync {
  constructor({ send, status, acknowledged, revision, answers }) {
    Object.assign(this, { send, status, acknowledged, revision });
    this.accepted = answers;
    this.latest = answers;
    this.pending = null;
    this.failures = 0;
    this.next = 0;
    this.stopped = false;
  }
  edit(text, now = Date.now()) {
    if (this.latest === this.accepted) this.first = now;
    this.latest = text;
    this.changed = now;
    this.status("Pending changes — kept in this tab until saved");
  }
  async flush(submit = false, now = Date.now()) {
    if (this.stopped || this.running || now < this.next) return false;
    if (!this.pending) {
      if (
        !submit &&
        (this.latest === this.accepted ||
          (now - this.changed < 1000 && now - this.first < 5000))
      )
        return false;
      this.pending = {
        path: submit ? "/exam/submit" : "/exam/save",
        body: {
          answers: this.latest,
          revision: this.revision,
          mutationId: crypto.randomUUID(),
        },
      };
    }
    this.running = true;
    this.status(
      this.pending.path.endsWith("submit") ? "Submitting…" : "Saving…",
    );
    try {
      const result = await this.send(this.pending.path, this.pending.body);
      this.revision = result.revision ?? result.answer_revision;
      this.accepted = this.pending.body.answers;
      const submitted = this.pending.path.endsWith("submit");
      this.pending = null;
      this.failures = 0;
      this.next = 0;
      this.acknowledged(this.accepted, this.revision, submitted);
      this.status(
        this.latest === this.accepted ? "Response saved" : "Pending changes",
      );
      if (submitted) this.stopped = true;
      return submitted || !submit;
    } catch (error) {
      if (error.status === 423) {
        this.next = now + 1000;
        this.status(
          "Examination paused by the invigilator. Unsent text is retained; the deadline continues.",
        );
        return false;
      }
      if (error.status && error.status < 500 && error.status !== 429) {
        this.stopped = true;
        this.status(
          "Save stopped: " +
            error.message +
            " Your unsent response remains visible. Reload to review the server response.",
        );
      } else {
        this.next = now + Math.min(30000, 1000 * 2 ** this.failures++);
        this.status(
          "Connection/save failed — retrying automatically; response kept in this tab",
        );
      }
      return false;
    } finally {
      this.running = false;
    }
  }
}
