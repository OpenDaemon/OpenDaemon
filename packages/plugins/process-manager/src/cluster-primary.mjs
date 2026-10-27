// Cluster primary for OpenDaemon's cluster mode.
//
// The process manager spawns this file (with an IPC channel) instead of the app. It forks the
// app as node:cluster workers, which is what lets N instances share one listening port; plain
// child processes would each fail with EADDRINUSE. Plain JavaScript so it runs on every
// supported Node version without a build step.
//
// Messages to the daemon:
//   { type: 'od:worker', event: 'online' | 'exit' | 'restart', index, pid, code?, signal? }
//   { type: 'od:log', index, pid, source: 'stdout' | 'stderr', message }
//   'ready'  once every initial worker has sent 'ready' (process.send('ready') in the app)
import cluster from 'node:cluster';

const script = process.env.OD_CLUSTER_SCRIPT;
const instances = Number(process.env.OD_CLUSTER_INSTANCES || '1');
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

cluster.setupPrimary({ exec: script, args, silent: true });

let stopping = false;
const restarts = new Map();
const ready = new Set();
let reportedReady = false;

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

function fork(index) {
  const worker = cluster.fork({ OD_WORKER_ID: String(index), OD_WORKER_COUNT: String(instances) });
  const pid = worker.process.pid;
  relay(worker.process.stdout, index, pid, 'stdout');
  relay(worker.process.stderr, index, pid, 'stderr');

  worker.on('online', () => send({ type: 'od:worker', event: 'online', index, pid }));
  worker.on('message', (message) => {
    if (message === 'ready' || (message && message.type === 'ready')) {
      ready.add(index);
      if (!reportedReady && ready.size >= instances) {
        reportedReady = true;
        send('ready');
      }
    }
  });
  worker.on('exit', (code, signal) => {
    send({ type: 'od:worker', event: 'exit', index, pid, code, signal });
    if (stopping) {
      if (Object.keys(cluster.workers ?? {}).length === 0) process.exit(0);
      return;
    }
    if (shouldRestart(index, code)) {
      restarts.set(index, (restarts.get(index) ?? 0) + 1);
      send({ type: 'od:worker', event: 'restart', index, pid });
      setTimeout(() => { if (!stopping) fork(index); }, policy.restartDelay ?? 1000);
    } else if (Object.keys(cluster.workers ?? {}).length === 0) {
      // Every worker is gone for good: exit so the daemon applies its own policy to the app
      process.exit(code ?? 1);
    }
  });
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
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
