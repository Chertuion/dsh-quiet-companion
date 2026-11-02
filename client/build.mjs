/** Offline closure-factory build: shares Host React/primitives, needs only Node.js. */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
const directory=dirname(fileURLToPath(import.meta.url));
const root=dirname(directory);
const [source,controller,css,manifest]=await Promise.all([
  readFile(join(directory,'factory.cjs'),'utf8'),readFile(join(directory,'controller.cjs'),'utf8'),
  readFile(join(directory,'settings.css'),'utf8'),readFile(join(root,'package.json'),'utf8').then(JSON.parse),
]);
const controllerInline=`(function(){const module={exports:{}};const exports=module.exports;\n${controller}\nreturn module.exports;})()`;
const compiled=source.replace("require('./controller.cjs')",controllerInline).replace("require('./settings.css')",JSON.stringify(css));
if(/require\(['"]\.\//u.test(compiled)) throw new Error('Client build has an unbundled relative import.');
const output=`/* Built by client/build.mjs. Shared module identities come from the Harness module table. */\nwindow.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},factory(require){\nconst module={exports:{}};const exports=module.exports;\n${compiled}\nreturn module.exports;\n}});\n`;
new Script(output,{filename:'client.js'});
await writeFile(join(root,'client.js'),output);
console.log(`Built client.js (${Buffer.byteLength(output)} bytes), offline; no React copy.`);
