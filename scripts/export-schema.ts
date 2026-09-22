import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {schema} from '../src/protocol';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'protocol/event.schema.json');
fs.mkdirSync(path.dirname(out), {recursive: true});
fs.writeFileSync(out, `${JSON.stringify(schema, null, 2)}\n`);
