// A global run holds at most three session workers. Model admission is still
// owned by TopicEngine so manual/automatic jobs share the same global cap.
export class BatchOrganizer {
  constructor({ engine, listSessions, archivedIds }) {
    Object.assign(this, { engine, listSessions, archivedIds });
    this.closed = false; this.run = null;
  }
  state() {
    return this.run ? structuredClone(this.run.status) : { running: false, phase: 'idle', sessions: 0, completed: 0, skipped: 0, turns: 0, failed: 0, errors: [] };
  }
  start() {
    if (this.closed) throw new Error('插件已停止');
    if (this.run?.status.running) return this.state();
    const run = {
      controller: new AbortController(), owned: new Set(),
      status: { running: true, phase: 'listing', sessions: 0, completed: 0, skipped: 0, turns: 0, failed: 0, errors: [] }
    };
    this.run = run;
    run.task = this.work(run);
    return this.state();
  }
  async work(run) {
    const { status, controller } = run;
    const fail = (id, error) => {
      status.failed++;
      if (status.errors.length < 20) status.errors.push({ sessionId: id, message: String(error?.message ?? error).slice(0, 160) });
    };
    try {
      // Missing archive information is an error, never permission to process all.
      const archived = new Set(await this.archivedIds());
      const rows = await this.listSessions(controller.signal);
      controller.signal.throwIfAborted();
      const ids = [...new Set(rows.filter(row => row.header?.origin !== 'subagent').map(row => row.header?.id).filter(id => typeof id === 'string' && !archived.has(id)))];
      status.sessions = ids.length; status.phase = 'processing';
      let cursor = 0;
      const worker = async () => {
        while (!controller.signal.aborted && cursor < ids.length) {
          const id = ids[cursor++];
          try {
            if (new Set(await this.archivedIds()).has(id)) { status.skipped++; continue; }
            // A pre-existing manual/automatic job owns itself. Wait without
            // cancelling it, then fill any rounds outside its original scope.
            if (this.engine.jobs.get(id)?.status.running) {
              await this.wait(run, this.engine.waitSession(id));
              controller.signal.throwIfAborted();
            }
            run.owned.add(id);
            await this.engine.start(id, undefined, false, false, async () => !controller.signal.aborted && !new Set(await this.archivedIds()).has(id));
            if (controller.signal.aborted) this.engine.cancel(id);
            const result = await this.wait(run, this.engine.waitSession(id));
            if (controller.signal.aborted) break;
            status.turns += Math.max(0, (result.done ?? 0) - (result.failed ?? 0));
            if (result.error) fail(id, new Error(result.error));
            if (result.skipped) status.skipped++; else status.completed++;
          } catch (error) {
            if (controller.signal.aborted) break;
            fail(id, error); status.completed++;
          } finally { run.owned.delete(id); }
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, ids.length) }, worker));
    } catch (error) { if (!controller.signal.aborted) fail(null, error); }
    finally { status.running = false; status.phase = controller.signal.aborted ? 'cancelled' : 'finished'; }
  }
  async wait(run, task) {
    const signal = run.controller.signal; signal.throwIfAborted();
    let abort;
    const stopped = new Promise((_, reject) => {
      abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([task, stopped]); }
    finally { signal.removeEventListener('abort', abort); }
  }
  cancel() {
    const run = this.run;
    if (run?.status.running) {
      run.controller.abort(); run.status.phase = 'stopping';
      for (const id of run.owned) this.engine.cancel(id);
    }
    return this.state();
  }
  dispose() { this.closed = true; this.cancel(); }
  async idle() { await this.run?.task; }
}
