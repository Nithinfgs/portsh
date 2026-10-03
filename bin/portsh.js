#!/usr/bin/env node
import { main } from '../src/cli.js';

// Exit quietly when the reader closes the pipe (e.g. `portsh | head`).
process.stdout.on('error', (err) => {
  if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EPIPE') process.exit(0);
  throw err;
});

process.exitCode = await main(process.argv.slice(2));
