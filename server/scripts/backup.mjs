import {execFileSync} from 'node:child_process';
import {mkdirSync,existsSync,unlinkSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config({path:fileURLToPath(new URL('../.env',import.meta.url)),quiet:true});
const source=new URL(process.env.DATABASE_URL),root=fileURLToPath(new URL('../../',import.meta.url));
const bin=process.env.POSTGRES_BIN||'C:/Program Files/PostgreSQL/18/bin';
const env={...process.env,PGPASSWORD:decodeURIComponent(source.password)};
const common=['--host',source.hostname,'--port',source.port||'5432','--username',decodeURIComponent(source.username)];
const command=process.argv[2]||'create';
if(command==='create'){
 const directory=resolve(root,'.local/backups');mkdirSync(directory,{recursive:true});
 const output=resolve(directory,'campusconnect-'+new Date().toISOString().replace(/[:.]/g,'-')+'.dump');
 try{execFileSync(resolve(bin,'pg_dump.exe'),[...common,'--dbname',source.pathname.slice(1),'--format=custom','--file',output],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});}
 catch(error){if(existsSync(output))unlinkSync(output);throw Error('Backup failed. Check that PostgreSQL is running.');}
 console.log('Backup saved: '+output);
}else if(command==='restore'){
 const input=process.argv[3],target=process.argv[4];
 if(!input||!target||!/^campusconnect_restore_[a-z0-9_]+$/.test(target))throw Error('Usage: npm run db:restore -- "C:/path/backup.dump" campusconnect_restore_test. Restore creates a NEW database and never overwrites the live one.');
 const file=resolve(input);if(!existsSync(file))throw Error('Backup file not found.');
 const adminUrl=new URL(source);adminUrl.pathname='/postgres';const client=new pg.Client({connectionString:adminUrl.toString()});await client.connect();
 try{if((await client.query('SELECT 1 FROM pg_database WHERE datname=$1',[target])).rowCount)throw Error('Target already exists. Choose a new restore database name.');await client.query('CREATE DATABASE "'+target+'"');}finally{await client.end();}
 try{execFileSync(resolve(bin,'pg_restore.exe'),[...common,'--dbname',target,'--no-owner','--no-privileges','--exit-on-error','--single-transaction',file],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});}catch{throw Error('Restore failed; the live database was not changed. Inspect the new target database before retrying with a new name.');}
 console.log('Restored into new database: '+target+'. Inspect it in pgAdmin. The live app still uses its original database.');
}else throw Error('Use create or restore.');
