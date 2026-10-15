// Builds the deployable app into dist/: one bundled app.js (includes the Claude SDK), the pages, and OpenCV.js.
import { build } from 'esbuild';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const out = 'dist';
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
await build({ entryPoints: ['src/app.js'], bundle: true, format: 'esm', target: 'es2020', minify: true, outfile: `${out}/app.js`, legalComments: 'eof' });
for (const f of ['index.html', 'styles.css', 'manifest.webmanifest', 'icon.svg']) fs.copyFileSync(`src/${f}`, `${out}/${f}`);
fs.copyFileSync('node_modules/@techstark/opencv-js/dist/opencv.js', `${out}/opencv.js`);
// app icons for home-screen install
execFileSync('python3', ['-c', `
from PIL import Image, ImageDraw
for n in (192, 512):
    im = Image.new('RGB', (n, n), '#1d3557'); d = ImageDraw.Draw(im); s = n / 512
    d.rounded_rectangle([0, 0, n - 1, n - 1], radius=int(96 * s), fill='#1d3557')
    d.arc([136*s, 80*s, 376*s, 320*s], 180, 360, fill='#ffffff', width=int(28*s))
    d.line([136*s, 200*s, 136*s, 420*s], fill='#ffffff', width=int(28*s)); d.line([376*s, 200*s, 376*s, 420*s], fill='#ffffff', width=int(28*s))
    d.line([136*s, 420*s, 376*s, 420*s], fill='#ffffff', width=int(28*s))
    d.arc([196*s, 170*s, 316*s, 290*s], 180, 360, fill='#e85d04', width=int(24*s))
    d.line([196*s, 230*s, 196*s, 420*s], fill='#e85d04', width=int(24*s)); d.line([316*s, 230*s, 316*s, 420*s], fill='#e85d04', width=int(24*s))
    im.save('${out}/icon-%d.png' % n)
`]);
const hash = crypto.createHash('sha1').update(fs.readFileSync(`${out}/app.js`)).update(fs.readFileSync(`${out}/styles.css`)).digest('hex').slice(0, 10);
fs.writeFileSync(`${out}/sw.js`, fs.readFileSync('src/sw.js', 'utf8').replace('__VERSION__', hash));
console.log('built', hash, fs.readdirSync(out).map((f) => `${f} ${(fs.statSync(`${out}/${f}`).size / 1024).toFixed(0)}K`).join(', '));
