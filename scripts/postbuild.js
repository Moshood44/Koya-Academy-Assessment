import fs from 'node:fs';
import path from 'node:path';

const src = path.resolve('dist', 'index.html');
const dest = path.resolve('dist', 'template.html');

if (fs.existsSync(src)) {
  fs.renameSync(src, dest);
  console.log('Renamed dist/index.html -> dist/template.html');
} else {
  console.error('dist/index.html not found');
  process.exit(1);
}
