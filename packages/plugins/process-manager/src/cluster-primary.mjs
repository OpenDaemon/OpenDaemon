// Cluster primary for OpenDaemon's cluster mode.
//
// The process manager spawns this file (with an IPC channel) instead of the app. It forks the
// app as node:cluster workers, which is what lets N instances share one listening port; plain
// child processes would each fail with EADDRINUSE. Plain JavaScript so it runs on every
// supported Node version without a build step.
//
// Messages from the daemon:
//   { type: 'od:scale', instances }  add workers, or gracefully retire the highest-numbered ones
//   { type: 'od:release', spec }     new default release (script, args, env) for every later fork
//   { type: 'od:prepare', id, index, spec?, timeout?, stable? }
//                                    start a candidate for worker `index` next to the live one
//   { type: 'od:commit', id, drain? }  the candidate takes over `index`; the old worker drains
//   { type: 'od:abort', id }         discard a candidate
//
// Messages to the daemon:
//   { type: 'od:worker', event: 'online' | 'exit' | 'restart', index, pid, code?, signal? }
//   { type: 'od:log', index, pid, source: 'stdout' | 'stderr', message }
//   { type: 'od:metrics', index, metrics }  a worker's SDK runtime metrics snapshot
//   { type: 'od:deploy', id, event: 'prepared' | 'committed' | 'aborted', ok, error?, pid? }
//   'ready'  once every initial worker has sent 'ready' (process.send('ready') in the app)
import cluster from 'node:cluster';

const script = process.env.OD_CLUSTER_SCRIPT;
let instances = Number(process.env.OD_CLUSTER_INSTANCES || '1');
const args = JSON.parse(process.env.OD_CLUSTER_ARGS || '[]');
/** @type {{ autoRestart?: boolean | string, restartDelay?: number, maxRestarts?: number, killTimeout?: number }} */
const policy = JSON.parse(process.env.OD_CLUSTER_POLICY || '{}');
// Workers inherit process.env; they should not see the primary's plumbing
delete process.env.OD_CLUSTER_SCRIPT;
delete process.env.OD_CLUSTER_INSTANCES;
delete process.env.OD_CLUSTER_ARGS;
delete process.env.OD_CLUSTER_POLICY;

if (!script) {
  console.error('cluster-primary: OD_CLUSTER_SCRIPT is not set');
  process.exit(1);
}

const send = (message) => {
  if (process.connected) process.send(message);
};

/** What a worker runs: the script and arguments, extra environment, and a version label */
let defaultSpec = { script, args, env: {}, version: '' };
/** index -> release a worker was committed with while it differs from the default (canary) */
const specs = new Map();

let stopping = false;
const restarts = new Map();
/** index -> live worker */
const workers = new Map();
/** indices being retired by a scale-down: their exit is expected, not a crash */
const retiring = new Set();
const ready = new Set();
let reportedReady = false;
/** workers replaced by a deploy: their exit is expected and must not touch the new worker's index */
const replaced = new WeakSet();
/** id -> candidate worker, started by od:prepare and not yet committed */
const candidates = new Map();

function shouldRestart(index, code) {
  const strategy = policy.autoRestart;
  if (strategy === false || strategy === 'never') return false;
  if (strategy === 'on-failure' && code === 0) return false;
  return (restarts.get(index) ?? 0) < (policy.maxRestarts ?? 10);
}

/** Forward a worker stream line by line (chunks can end mid-line) */
function relay(stream, index, pid, source) {
  let pending = '';
  const emit = (line) => {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (text) send({ type: 'od:log', index, pid, source, message: text });
  };
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop() ?? '';
    lines.forEach(emit);
  });
  stream.on('end', () => {
    emit(pending);
    pending = '';
  });
}

/** Start a worker running `spec`, relaying its output */
function spawnWorker(index, spec) {
  cluster.setupPrimary({ exec: spec.script, args: spec.args, silent: true });
  const worker = cluster.fork({
    ...spec.env,
    OD_WORKER_ID: String(index),
    OD_WORKER_COUNT: String(instances),
    ...(spec.version ? { OD_RELEASE: spec.version } : {}),
  });
  const pid = worker.process.pid;
  relay(worker.process.stdout, index, pid, 'stdout');
  relay(worker.process.stderr, index, pid, 'stderr');
  return worker;
}

/** Make `worker` the live worker of `index`: track it, report it, restart it when it crashes */
function adopt(index, worker, alreadyOnline) {
  const pid = worker.process.pid;
  workers.set(index, worker);

  if (alreadyOnline) send({ type: 'od:worker', event: 'online', index, pid });
  else worker.on('online', () => send({ type: 'od:worker', event: 'online', index, pid }));
  worker.on('message', (message) => {
    if (message && message.type === 'od:metrics') {
      send({ type: 'od:metrics', index, metrics: message.metrics });
      return;
    }
    if (message === 'ready' || (message && message.type === 'ready')) {
      ready.add(index);
      if (!reportedReady && ready.size >= instances) {
        reportedReady = true;
        send('ready');
      }
    }
  });
  worker.on('exit', (code, signal) => {
    if (replaced.has(worker)) return;
    if (workers.get(index) === worker) workers.delete(index);
    send({ type: 'od:worker', event: 'exit', index, pid, code, signal });
    if (retiring.delete(index)) return;
    if (stopping) {
      if (Object.keys(cluster.workers ?? {}).length === 0) process.exit(0);
      return;
    }
    if (shouldRestart(index, code)) {
      restarts.set(index, (restarts.get(index) ?? 0) + 1);
      send({ type: 'od:worker', event: 'restart', index, pid });
      setTimeout(() => { if (!stopping && index < instances) fork(index); }, policy.restartDelay ?? 1000);
    } else if (Object.keys(cluster.workers ?? {}).length === 0) {
      // Every worker is gone for good: exit so the daemon applies its own policy to the app
      process.exit(code ?? 1);
    }
  });
}

function fork(index) {
  adopt(index, spawnWorker(index, specs.get(index) ?? defaultSpec), false);
}

const reply = (id, event, ok, extra = {}) => send({ type: 'od:deploy', id, event, ok, ...extra });

/**
 * Start a candidate for `index` next to the live worker and report when it is ready: it said
 * 'ready', started listening, or stayed up for `stable` ms (apps without a port). The candidate
 * never serves under the old index, so a failed release leaves the live worker untouched.
 */
function prepare({ id, index, spec, timeout = 30000, stable = 1000 }) {
  if (stopping || candidates.has(id) || !Number.isInteger(index) || index < 0) {
    reply(id, 'prepared', false, { error: 'cannot prepare a candidate now' });
    return;
  }
  const worker = spawnWorker(index, { ...defaultSpec, ...spec });
  const entry = { worker, index, spec: { ...defaultSpec, ...spec }, online: false, settled: false };
  candidates.set(id, entry);

  const finish = (ok, error) => {
    if (entry.settled) return;
    entry.settled = true;
    clearTimeout(deadline);
    clearTimeout(stableTimer);
    if (!ok) {
      candidates.delete(id);
      if (!worker.isDead()) worker.process.kill('SIGKILL');
    }
    reply(id, 'prepared', ok, ok ? { pid: worker.process.pid } : { error });
  };
  let stableTimer;
  const deadline = setTimeout(() => finish(false, `not ready after ${String(timeout)}ms`), timeout);
  worker.on('online', () => {
    entry.online = true;
    stableTimer = setTimeout(() => finish(true), stable);
  });
  worker.on('listening', () => finish(true));
  worker.on('message', (message) => {
    if (message === 'ready' || (message && message.type === 'ready')) finish(true);
  });
  worker.on('exit', (code, signal) => {
    if (!entry.settled) finish(false, `exited with ${signal ?? `code ${String(code)}`} before it was ready`);
  });
}

function commit({ id, drain }) {
  const entry = candidates.get(id);
  if (!entry || !entry.settled || entry.worker.isDead()) {
    reply(id, 'committed', false, { error: 'the candidate is not available' });
    return;
  }
  candidates.delete(id);
  const old = workers.get(entry.index);
  specs.set(entry.index, entry.spec);
  adopt(entry.index, entry.worker, true);
  ready.add(entry.index);
  if (old) {
    replaced.add(old);
    // disconnect() lets the old worker finish in-flight requests; force it after `drain`
    old.disconnect();
    setTimeout(() => { if (!old.isDead()) old.process.kill('SIGKILL'); }, drain ?? policy.killTimeout ?? 5000).unref();
  }
  reply(id, 'committed', true, { pid: entry.worker.process.pid });
}

function abort({ id }) {
  const entry = candidates.get(id);
  candidates.delete(id);
  if (entry && !entry.worker.isDead()) entry.worker.process.kill('SIGKILL');
  reply(id, 'aborted', true);
}

function scale(target) {
  if (stopping || !Number.isInteger(target) || target < 1) return;
  const previous = instances;
  instances = target;
  for (let i = previous; i < target; i++) {
    if (!workers.has(i)) fork(i);
  }
  for (const [index, worker] of workers) {
    if (index >= target) {
      retiring.add(index);
      // disconnect() lets the worker finish in-flight requests; force it after killTimeout
      worker.disconnect();
      setTimeout(() => { if (!worker.isDead()) worker.process.kill('SIGKILL'); }, policy.killTimeout ?? 5000).unref();
    }
  }
}

process.on('message', (message) => {
  if (!message) return;
  if (message.type === 'od:scale') scale(Number(message.instances));
  else if (message.type === 'od:release') {
    defaultSpec = { ...defaultSpec, ...message.spec };
    specs.clear();
  } else if (message.type === 'od:prepare') prepare(message);
  else if (message.type === 'od:commit') commit(message);
  else if (message.type === 'od:abort') abort(message);
});

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  for (const { worker } of candidates.values()) worker.process.kill('SIGKILL');
  candidates.clear();
  const workers = Object.values(cluster.workers ?? {});
  if (workers.length === 0) process.exit(0);
  // Pass the signal on so apps can drain connections, then force the rest
  for (const worker of workers) worker.process.kill(signal);
  setTimeout(() => {
    for (const worker of Object.values(cluster.workers ?? {})) worker.process.kill('SIGKILL');
    process.exit(0);
  }, policy.killTimeout ?? 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// The daemon went away without stopping us: don't leave the workers behind
process.on('disconnect', () => shutdown('SIGTERM'));

for (let i = 0; i < instances; i++) fork(i);
