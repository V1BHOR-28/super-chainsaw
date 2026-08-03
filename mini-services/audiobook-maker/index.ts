/**
 * index.ts — Bun wrapper that spawns the audiobook-maker Flask app as a child process.
 *
 * The Flask app (audiobook_app.py) is a 15K-line Python monolith that handles
 * ALL audiobook functionality: EPUB parsing, edge-tts synthesis, M4B/MP3 output,
 * job state, progress streaming, downloads. It runs on port 5601 (ABM_PORT env).
 *
 * This wrapper:
 *   1. Spawns `python3 audiobook_app.py` as a long-lived child process
 *   2. Pipes stdout/stderr to the parent process so logs appear in dev.log
 *   3. Forwards SIGTERM/SIGINT for clean shutdown
 *   4. Restarts on crash (bun --hot watches this file; the Python process
 *      itself is restarted by the supervisor below on unexpected exit)
 *
 * ARIA's Next.js frontend calls the Flask API via the gateway proxy:
 *   fetch('/api/voices?XTransformPort=5601')
 *   fetch('/api/analyze?XTransformPort=5601', { method: 'POST', body: formData })
 *   fetch('/api/generate?XTransformPort=5601', { method: 'POST', body: JSON.stringify({...}) })
 *
 * Port 5601 matches audiobook-maker's default (ABM_PORT env var).
 */

import { spawn, ChildProcess } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PYTHON = process.env.PYTHON || 'python3';
const SCRIPT = resolve(__dirname, 'audiobook_app.py');
const PORT = process.env.ABM_PORT || '5601';

let child: ChildProcess | null = null;
let shuttingDown = false;

function startFlask(): ChildProcess {
  console.log(`[audiobook-maker] Starting Flask app on port ${PORT}...`);
  const dataDir = process.env.ABM_DATA_DIR || resolve(__dirname, 'data');
  const env = {
    ...process.env,
    ABM_PORT: PORT,
    // Local filesystem for job storage (no S3/R2 configured)
    ABM_DATA_DIR: dataDir,
    ABM_UPLOAD_DIR: dataDir,
  };

  const proc = spawn(PYTHON, [SCRIPT], {
    cwd: __dirname,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.stdout?.on('data', (data: Buffer) => {
    process.stdout.write(`[abm] ${data}`);
  });

  proc.stderr?.on('data', (data: Buffer) => {
    process.stderr.write(`[abm] ${data}`);
  });

  proc.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`[audiobook-maker] Flask exited unexpectedly (code=${code}, signal=${signal}). Restarting in 3s...`);
    setTimeout(() => {
      if (!shuttingDown) {
        child = startFlask();
      }
    }, 3000);
  });

  return proc;
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[audiobook-maker] Shutting down Flask app...');
  if (child && !child.killed) {
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child && !child.killed) {
        child.kill('SIGKILL');
      }
      process.exit(0);
    }, 5000);
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

child = startFlask();
console.log(`[audiobook-maker] Wrapper started — Flask PID will appear above. Port: ${PORT}`);
