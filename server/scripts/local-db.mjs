import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import dotenv from 'dotenv';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const bin = process.env.POSTGRES_BIN || 'C:/Program Files/PostgreSQL/18/bin';
const data = resolve(root, '.local/postgres');
const envFile = resolve(root, 'server/.env');
const command = process.argv[2] || 'start';
function run(name, args) {
  return execFileSync(resolve(bin, `${name}.exe`), args, { windowsHide: true, stdio: 'ignore', timeout: 60000 });
}
mkdirSync(dirname(data), { recursive: true });
if (!existsSync(envFile)) {
  const password = randomBytes(24).toString('hex');
  writeFileSync(envFile, `PORT=4000\nDATABASE_URL=postgresql://campusconnect:${password}@127.0.0.1:5434/campusconnect\nJWT_SECRET=${randomBytes(48).toString('hex')}\n# Website origin is detected automatically at startup.\n`, { mode: 0o600 });
}
const env = dotenv.parse(readFileSync(envFile));
const databasePort = new URL(env.DATABASE_URL).port || '5434';
if (command === 'stop') {
  if (existsSync(resolve(data, 'postmaster.pid'))) {
    try { run('pg_ctl', ['stop', '-D', data, '-m', 'fast', '-w']); }
    catch { console.error('This terminal could not signal the database process. Stop it from the Windows terminal that started it.'); process.exit(1); }
  }
  console.log('CampusConnect database stopped.');
  process.exit(0);
}
if (!existsSync(resolve(data, 'PG_VERSION'))) {
  const pwFile = resolve(dirname(data), '.campusconnect-init-password');
  writeFileSync(pwFile, decodeURIComponent(new URL(env.DATABASE_URL).password), { mode: 0o600 });
  try {
    console.log('Creating a dedicated local PostgreSQL cluster…');
    run('initdb', ['-D', data, '-U', 'campusconnect', '-A', 'scram-sha-256', '--encoding=UTF8', '--locale=C', `--pwfile=${pwFile}`]);
  } finally { unlinkSync(pwFile); }
}
const adminUrl = new URL(env.DATABASE_URL);
adminUrl.pathname = '/postgres';
const options = { connectionString: adminUrl.toString(), connectionTimeoutMillis: 5000 };
let admin = new pg.Client(options);
try { await admin.connect(); }
catch (error) {
  await admin.end().catch(() => {});
  if (error.code !== 'ECONNREFUSED') throw error;
  run('pg_ctl', ['start', '-D', data, '-l', resolve(dirname(data), 'campusconnect-postgres.log'), '-o', `-h 127.0.0.1 -p ${databasePort}`, '-w']);
  admin = new pg.Client(options);
  await admin.connect();
}
try {
  const found = await admin.query("SELECT 1 FROM pg_database WHERE datname='campusconnect'");
  if (!found.rowCount) await admin.query('CREATE DATABASE campusconnect');
} finally { await admin.end(); }
console.log(`CampusConnect PostgreSQL is ready on 127.0.0.1:${databasePort}.`);
