// Gives the `npm install` layers of the Dockerfile files that do not change when the release number does.
//
// A version bump edits `version` in package.json and package-lock.json. Docker keys the cache of
// `COPY package.json ... && RUN npm install` on those bytes, so every release rebuilt the three installs (frontend,
// backend, runtime) from scratch: about five minutes, against the 300 s the deploy watcher allows a build. This script
// runs in a throw-away stage and rewrites the manifests with a fixed version; the next stage copies them from there
// (`COPY --from` is keyed on the content it copies, not on the stage that made it), so the install layers stay cached
// until a dependency really changes. The real manifests are copied back AFTER the install, where they cost nothing.
//
// Usage: node strip-version.cjs <file> [<file>...]   (a missing file is skipped: the lock file is optional)
const fs = require('node:fs');

const FIXED = '0.0.0';

for (const file of process.argv.slice(2)) {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') continue;
    throw err;
  }
  json.version = FIXED;
  // lockfileVersion 2/3: the root package is repeated under packages[""]
  if (json.packages && json.packages['']) json.packages[''].version = FIXED;
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
}
