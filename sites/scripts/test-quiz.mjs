import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
mkdirSync('outputs',{recursive:true});
await build({entryPoints:['tests/quiz.test.ts'],bundle:true,platform:'node',format:'esm',packages:'external',outfile:'outputs/quiz.test.mjs'});
const r=spawnSync(process.execPath,['--test','outputs/quiz.test.mjs'],{stdio:'inherit'});
process.exitCode=r.status??1;
