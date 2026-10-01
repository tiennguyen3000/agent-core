#!/usr/bin/env node
// Global entry point. It only loads the compiled CLI: importing the module does
// not run anything by itself (the entrypoint guard compares process.argv[1]),
// so this shim owns the exit code.
import { runCli } from '../dist/cli/main.js';

process.exitCode = await runCli({ argv: process.argv.slice(2) });
