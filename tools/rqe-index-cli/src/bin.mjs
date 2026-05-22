#!/usr/bin/env node
import { runCli } from "./cli.mjs";

const code = await runCli(process.argv.slice(2));
process.exit(code);
