import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
var pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));
var gitSha = (function () {
    try {
        return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
    }
    catch (_a) {
        return 'unknown';
    }
})();
export default defineConfig({
    plugins: [react()],
    define: {
        __APP_VERSION__: JSON.stringify(pkg.version),
        __GIT_REVISION__: JSON.stringify(gitSha),
    },
    server: {
        port: 3000
    }
});
