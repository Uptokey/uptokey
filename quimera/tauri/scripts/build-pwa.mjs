import { spawnSync } from 'child_process'; const r = spawnSync('npm', ['run', 'build'], { cwd: '../uptokey/uptokey-pwa', stdio: 'inherit', shell: true }); process.exit(r.status);
