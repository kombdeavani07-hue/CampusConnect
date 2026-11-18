import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { z } from 'zod';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { registerCareerRoutes, saveJobSkills } from './career.js';
import { registerRecruitmentRoutes, tokenHash } from './recruitment.js';
import { getClientOrigin } from '../../scripts/network.mjs';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
pg.types.setTypeParser(1082, value => value);
if (!process.env.DATABASE_URL || !process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error('Run npm run setup from the project folder to configure the local database and session secret.');
}
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
db.on('error', error => console.error('Database connection interrupted:', error.code));
const app = express();
app.disable('x-powered-by');
app.use(helmet());

const clientOrigin = getClientOrigin();
// Check the current Wi-Fi address for every mutation, not only at startup.
console.log('Open CampusConnect on this Wi-Fi: ' + clientOrigin);
app.use((req,res,next) => {
  if (!['GET','HEAD','OPTIONS'].includes(req.method) && req.headers.origin) {
    let currentOrigin;
    try { currentOrigin = getClientOrigin(); }
    catch { return res.status(503).json({error:'No active Wi-Fi address was found. Reconnect Wi-Fi and restart CampusConnect.'}); }
    if (req.headers.origin !== currentOrigin) {
      return res.status(403).json({error:'This page uses a different website address. Open ' + currentOrigin + ' and try again.'});
    }
  }
  next();
});
app.use('/api', rateLimit({windowMs:60_000,limit:300,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Too many requests. Please wait a minute.'}}));
const loginLimit = rateLimit({windowMs:15*60_000,limit:40,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Too many login attempts. Please try again later.'}});
function fail(status,message) { const error = new Error(message); error.status = status; throw error; }
const id = z.coerce.number().int().positive();
const name = z.string().trim().min(2).max(100);
const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(8).max(72).refine(value => Buffer.byteLength(value,'utf8') <= 72, 'Password must be at most 72 bytes.');
const cgpa = z.coerce.number().min(0).max(10);
const year = z.coerce.number().int().min(2000).max(2100);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value, 'Enter a valid date.');
const cookie = 'campus_session';
function session(res,user) {
  const token = jwt.sign({sub:String(user.user_id)},process.env.JWT_SECRET,{expiresIn:'8h',algorithm:'HS256'});
  res.cookie(cookie,token,{httpOnly:true,sameSite:'strict',secure:process.env.NODE_ENV==='production',maxAge:8*60*60*1000,path:'/'});
}
const publicUser = user => ({user_id:user.user_id,full_name:user.full_name,email:user.email,role:user.role});
async function auth(req,res,next) {
  try {
    const raw = req.headers.cookie?.split(';').map(value=>value.trim()).find(value=>value.startsWith(`${cookie}=`))?.slice(cookie.length+1);
    if (!raw) return res.status(401).json({error:'Please sign in to continue.'});
    const token = jwt.verify(decodeURIComponent(raw),process.env.JWT_SECRET,{algorithms:['HS256']});
    const result = await db.query('SELECT user_id,full_name,email,role FROM users WHERE user_id=$1',[id.parse(token.sub)]);
    if (!result.rowCount) return res.status(401).json({error:'Your session has expired. Please sign in again.'});
    req.user=result.rows[0]; next();
  } catch { res.status(401).json({error:'Your session has expired. Please sign in again.'}); }
}
const role = (...roles) => (req,res,next) => roles.includes(req.user.role) ? next() : res.status(403).json({error:'You do not have permission to do that.'});
async function transaction(fn) {
  const connection=await db.connect();
  try { await connection.query('BEGIN'); const result=await fn(connection); await connection.query('COMMIT'); return result; }
  catch(error) { await connection.query('ROLLBACK'); throw error; }
  finally { connection.release(); }
}
async function notify(connection,user,message) { await connection.query('INSERT INTO notifications(user_id,message) VALUES($1,$2)',[user,message]); }
async function ownedApplication(connection,applicationId,user) {
  const result=await connection.query(`SELECT a.*,s.user_id AS student_user_id,j.company_id,j.job_title,c.company_name,c.user_id AS company_user_id
    FROM applications a JOIN students s USING(student_id) JOIN jobs j USING(job_id) JOIN companies c USING(company_id)
    WHERE a.application_id=$1 FOR UPDATE OF a`,[applicationId]);
  if (!result.rowCount) fail(404,'Application not found.');
  const row=result.rows[0];
  if(user.role!=='admin' && row.company_user_id!==user.user_id) fail(403,'You can only manage applications to your own jobs.');
  return row;
}

registerCareerRoutes(app,{db,auth,role,transaction,fail,id});
app.use(express.json({ limit: '30kb' }));

registerRecruitmentRoutes(app,{db,auth,role,fail,id});
app.get('/api/health',async(req,res)=>{ await db.query('SELECT 1'); res.json({ok:true,database:'connected'}); });
app.post('/api/auth/login',loginLimit,async(req,res)=>{
  const input=z.object({email,password:z.string().min(1).max(200)}).parse(req.body);
  const result=await db.query('SELECT * FROM users WHERE email=$1',[input.email]);
  const user=result.rows[0];
  if(!user || !(await bcrypt.compare(input.password,user.password_hash))) fail(401,'Email or password is incorrect.');
  session(res,user); res.json({user:publicUser(user)});
});
app.post('/api/auth/register',loginLimit,async(req,res)=>{
  const base=z.object({full_name:name,email,password,role:z.enum(['student','company'])}).parse(req.body);
  const details=base.role==='student'
    ? z.object({roll_number:z.string().trim().min(2).max(30),branch:name,graduation_year:year,cgpa}).parse(req.body)
    : z.object({company_name:z.string().trim().min(2).max(150),website:z.union([z.literal(''),z.url().max(300).refine(value=>/^https?:\/\//.test(value),'Use an HTTP or HTTPS website.')]).default('')}).parse(req.body);
  const hash=await bcrypt.hash(base.password,12);
  const user=await transaction(async connection=>{
    let invitation;
    if(base.role==='company'){
      const token=z.string().regex(/^[a-f0-9]{64}$/,'Enter the invitation code supplied by your placement cell.').parse(req.body.invitation_code);
      invitation=(await connection.query('SELECT * FROM company_invitations WHERE token_hash=$1 FOR UPDATE',[tokenHash(token)])).rows[0];
      if(!invitation||invitation.email!==base.email||invitation.used_at||invitation.revoked_at||new Date(invitation.expires_at)<=new Date())fail(403,'This invitation is invalid, expired, already used, or belongs to a different email.');
      if(invitation.company_name!==details.company_name)fail(400,'Use the company name provided on your invitation.');
    }
    const row=(await connection.query('INSERT INTO users(full_name,email,password_hash,role) VALUES($1,$2,$3,$4) RETURNING user_id,full_name,email,role',[base.full_name,base.email,hash,base.role])).rows[0];
    if(base.role==='student') await connection.query('INSERT INTO students(user_id,roll_number,branch,graduation_year,cgpa) VALUES($1,$2,$3,$4,$5)',[row.user_id,details.roll_number,details.branch,details.graduation_year,details.cgpa]);
    else await connection.query('INSERT INTO companies(user_id,company_name,website) VALUES($1,$2,$3)',[row.user_id,details.company_name,details.website]);
    if(invitation)await connection.query('UPDATE company_invitations SET used_at=NOW() WHERE invitation_id=$1',[invitation.invitation_id]);
    await notify(connection,row.user_id,base.role==='student'?'Welcome! Your account is waiting for placement cell verification.':'Welcome! Your company workspace is ready.');
    return row;
  });
  session(res,user); res.status(201).json({user});
});
app.post('/api/auth/logout',(req,res)=>{res.clearCookie(cookie,{httpOnly:true,sameSite:'strict',path:'/'}); res.json({ok:true});});
app.get('/api/auth/me',auth,(req,res)=>res.json({user:req.user}));

app.get('/api/dashboard',auth,async(req,res)=>{
  const user=req.user;
  const student=user.role==='student'?(await db.query('SELECT * FROM students WHERE user_id=$1',[user.user_id])).rows[0]:null;
  const company=user.role==='company'?(await db.query('SELECT * FROM companies WHERE user_id=$1',[user.user_id])).rows[0]:null;
  const jobs=(await db.query(`SELECT j.*,c.company_name,COUNT(a.application_id)::int AS applicant_count, COALESCE((SELECT array_agg(k.name ORDER BY lower(k.name)) FROM job_skills jk JOIN skills k USING(skill_id) WHERE jk.job_id=j.job_id), ARRAY[]::text[]) AS preferred_skills
    FROM jobs j JOIN companies c USING(company_id) LEFT JOIN applications a USING(job_id)
    WHERE ($1='admin') OR ($1='company' AND c.user_id=$2) OR ($1='student')
    GROUP BY j.job_id,c.company_id ORDER BY j.created_at DESC,j.job_id`,[user.role,user.user_id])).rows;
  const applications=(await db.query(`SELECT a.*,j.job_title,j.salary,c.company_name,u.full_name,u.email,s.roll_number,s.branch,s.cgpa,s.graduation_year
    FROM applications a JOIN jobs j USING(job_id) JOIN companies c USING(company_id)
    JOIN students s USING(student_id) JOIN users u ON u.user_id=s.user_id
    WHERE $1='admin' OR ($1='company' AND c.user_id=$2) OR ($1='student' AND s.user_id=$2)
    ORDER BY a.applied_at DESC,a.application_id DESC LIMIT CASE WHEN $1='student' THEN NULL ELSE 5 END`,[user.role,user.user_id])).rows;
  const interviews=(await db.query(`SELECT i.*,j.job_title,c.company_name,u.full_name,a.status AS application_status
    FROM interviews i JOIN applications a USING(application_id) JOIN jobs j USING(job_id) JOIN companies c USING(company_id)
    JOIN students s USING(student_id) JOIN users u ON u.user_id=s.user_id
    WHERE $1='admin' OR ($1='company' AND c.user_id=$2) OR ($1='student' AND s.user_id=$2)
    ORDER BY i.scheduled_at`,[user.role,user.user_id])).rows;
  const offers=(await db.query(`SELECT o.*,j.job_title,c.company_name,u.full_name,s.branch,s.graduation_year
    FROM offers o JOIN applications a USING(application_id) JOIN jobs j USING(job_id) JOIN companies c USING(company_id)
    JOIN students s USING(student_id) JOIN users u ON u.user_id=s.user_id
    WHERE $1='admin' OR ($1='company' AND c.user_id=$2) OR ($1='student' AND s.user_id=$2)
    ORDER BY o.offer_date DESC,o.offer_id DESC`,[user.role,user.user_id])).rows;
  const students=user.role==='admin'?(await db.query('SELECT s.*,u.full_name,u.email FROM students s JOIN users u USING(user_id) ORDER BY s.student_id DESC LIMIT 5')).rows:[];
  const companies=user.role==='admin'?(await db.query('SELECT c.*,u.full_name,u.email FROM companies c JOIN users u USING(user_id) ORDER BY c.company_id DESC')).rows:[];
  const notifications=(await db.query('SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC,notification_id DESC LIMIT 30',[user.user_id])).rows;
  const totals=user.role==='admin'?(await db.query(`SELECT
    (SELECT COUNT(*)::int FROM students) AS students,
    (SELECT COUNT(*)::int FROM students WHERE verified=FALSE) AS unverified_students,
    (SELECT COUNT(*)::int FROM companies) AS companies,
    (SELECT COUNT(*)::int FROM jobs j JOIN companies c USING(company_id) WHERE j.status='open' AND j.deadline>=CURRENT_DATE) AS active_jobs,
    (SELECT COUNT(DISTINCT a.student_id)::int FROM offers o JOIN applications a USING(application_id) WHERE o.status='accepted') AS placed_students`)).rows[0]:null;
  const application_count=Number((await db.query("SELECT COUNT(*) FROM applications a JOIN jobs j USING(job_id) JOIN companies c USING(company_id) JOIN students s USING(student_id) WHERE $1='admin' OR ($1='company' AND c.user_id=$2) OR ($1='student' AND s.user_id=$2)",[user.role,user.user_id])).rows[0].count);
  const student_filter_options=user.role==='admin'?{branches:(await db.query('SELECT DISTINCT branch FROM students ORDER BY branch')).rows.map(r=>r.branch),years:(await db.query('SELECT DISTINCT graduation_year FROM students ORDER BY graduation_year')).rows.map(r=>r.graduation_year)}:null;
  const career_summary=student?{skills:(await db.query('SELECT k.name FROM student_skills sk JOIN skills k USING(skill_id) WHERE sk.student_id=$1',[student.student_id])).rows.map(item=>item.name)}:null;
  res.json({user,student,company,jobs,applications,interviews,offers,students,companies,notifications,totals,career_summary,application_count,student_filter_options});
});
app.post('/api/students',auth,role('admin'),async(req,res)=>{
  const input=z.object({full_name:name,email,password,roll_number:z.string().trim().min(2).max(30),branch:name,graduation_year:year,cgpa}).parse(req.body);
  const hash=await bcrypt.hash(input.password,12);
  await transaction(async connection=>{
    const user=(await connection.query("INSERT INTO users(full_name,email,password_hash,role) VALUES($1,$2,$3,'student') RETURNING user_id",[input.full_name,input.email,hash])).rows[0];
    await connection.query('INSERT INTO students(user_id,roll_number,branch,graduation_year,cgpa,verified) VALUES($1,$2,$3,$4,$5,TRUE)',[user.user_id,input.roll_number,input.branch,input.graduation_year,input.cgpa]);
    await notify(connection,user.user_id,'Your placement administrator created and verified your account.');
  });res.status(201).json({ok:true});
});
app.patch('/api/students/:id',auth,role('admin'),async(req,res)=>{
  const input=z.object({full_name:name,roll_number:z.string().trim().min(2).max(30),branch:name,graduation_year:year,cgpa}).parse(req.body);
  await transaction(async connection=>{
    const result=await connection.query('UPDATE students SET roll_number=$1,branch=$2,graduation_year=$3,cgpa=$4 WHERE student_id=$5 RETURNING user_id',[input.roll_number,input.branch,input.graduation_year,input.cgpa,id.parse(req.params.id)]);
    if(!result.rowCount)fail(404,'Student not found.');
    await connection.query('UPDATE users SET full_name=$1 WHERE user_id=$2',[input.full_name,result.rows[0].user_id]);
    await notify(connection,result.rows[0].user_id,'Your academic profile was updated by the placement cell.');
  });res.json({ok:true});
});
app.patch('/api/students/:id/verify',auth,role('admin'),async(req,res)=>{
  const verified=z.object({verified:z.boolean()}).parse(req.body).verified;
  await transaction(async connection=>{
    const result=await connection.query('UPDATE students SET verified=$1 WHERE student_id=$2 RETURNING user_id',[verified,id.parse(req.params.id)]);
    if(!result.rowCount) fail(404,'Student not found.');
    await notify(connection,result.rows[0].user_id,verified?'Your academic profile has been verified. You can apply to eligible jobs.':'Your academic profile needs verification. Please contact the placement cell.');
  }); res.json({ok:true});
});
const jobSchema=z.object({job_title:z.string().trim().min(3).max(150),description:z.string().trim().min(20).max(5000),location:name,min_cgpa:cgpa,salary:z.coerce.number().positive().max(9999999999),eligible_branches:z.array(name).max(20).default([]),deadline:date,drive_date:date.nullable().default(null),drive_venue:z.string().trim().max(200).default(''),selection_rounds:z.string().trim().max(1000).default(''),drive_instructions:z.string().trim().max(3000).default(''),preferred_skills:z.array(z.string().trim().min(2).max(80)).max(30).default([])});
app.post('/api/jobs',auth,role('company'),async(req,res)=>{
  const input=jobSchema.parse(req.body);
  await transaction(async connection=>{
    const company=(await connection.query('SELECT * FROM companies WHERE user_id=$1 FOR UPDATE',[req.user.user_id])).rows[0];
    if(!company) fail(404,'Company profile not found.');
    const today=(await connection.query('SELECT CURRENT_DATE::text AS today')).rows[0].today;
    if(input.deadline<today) fail(400,'The application deadline must be today or later.');
    const created=(await connection.query('INSERT INTO jobs(company_id,job_title,description,location,min_cgpa,salary,eligible_branches,deadline) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING job_id',[company.company_id,input.job_title,input.description,input.location,input.min_cgpa,input.salary,input.eligible_branches,input.deadline])).rows[0];
    await connection.query('UPDATE jobs SET drive_date=$1,drive_venue=$2,selection_rounds=$3,drive_instructions=$4 WHERE job_id=$5',[input.drive_date,input.drive_venue,input.selection_rounds,input.drive_instructions,created.job_id]);
    await saveJobSkills(connection,created.job_id,input.preferred_skills);
  });res.status(201).json({ok:true});
});
app.patch('/api/jobs/:id',auth,role('admin','company'),async(req,res)=>{
  const input=jobSchema.parse(req.body);
  await transaction(async connection=>{
    const job=(await connection.query(`SELECT j.*,c.user_id AS owner FROM jobs j JOIN companies c USING(company_id) WHERE job_id=$1 FOR UPDATE OF j,c`,[id.parse(req.params.id)])).rows[0];
    if(!job)fail(404,'Job not found.');
    if(req.user.role!=='admin'&&job.owner!==req.user.user_id)fail(403,'You cannot edit this job.');
    const today=(await connection.query('SELECT CURRENT_DATE::text AS today')).rows[0].today;
    if(input.deadline<today)fail(400,'Choose a current or future deadline. Close or cancel an expired role instead.');
    const applied=await connection.query('SELECT 1 FROM applications WHERE job_id=$1 LIMIT 1',[job.job_id]);
    if(applied.rowCount&&(Number(job.min_cgpa)!==input.min_cgpa||JSON.stringify([...job.eligible_branches].sort())!==JSON.stringify([...input.eligible_branches].sort())))fail(409,'Eligibility cannot change after students have applied.');
    await connection.query('UPDATE jobs SET job_title=$1,description=$2,location=$3,min_cgpa=$4,salary=$5,eligible_branches=$6,deadline=$7 WHERE job_id=$8',[input.job_title,input.description,input.location,input.min_cgpa,input.salary,input.eligible_branches,input.deadline,job.job_id]);
    await connection.query('UPDATE jobs SET drive_date=$1,drive_venue=$2,selection_rounds=$3,drive_instructions=$4 WHERE job_id=$5',[input.drive_date,input.drive_venue,input.selection_rounds,input.drive_instructions,job.job_id]);
    await saveJobSkills(connection,job.job_id,input.preferred_skills);
  });res.json({ok:true});
});
app.patch('/api/jobs/:id/status',auth,role('admin','company'),async(req,res)=>{
  const status=z.object({status:z.enum(['open','closed','cancelled'])}).parse(req.body).status;
  const result=await db.query(`UPDATE jobs j SET status=$1 FROM companies c WHERE j.company_id=c.company_id AND j.job_id=$2 AND ($3='admin' OR (c.user_id=$4)) RETURNING j.job_id`,[status,id.parse(req.params.id),req.user.role,req.user.user_id]);
  if(!result.rowCount) fail(403,'Job not found or you cannot manage it.');
  res.json({ok:true});
});
app.post('/api/jobs/:id/apply',auth,role('student'),async(req,res)=>{
  await transaction(async connection=>{
    const student=(await connection.query('SELECT * FROM students WHERE user_id=$1 FOR UPDATE',[req.user.user_id])).rows[0];
    if(!student?.verified) fail(403,'The placement cell must verify your profile before you can apply.');
    const job=(await connection.query(`SELECT j.*,c.user_id AS company_user_id,j.deadline>=CURRENT_DATE AS in_time FROM jobs j JOIN companies c USING(company_id) WHERE job_id=$1 FOR UPDATE OF j,c`,[id.parse(req.params.id)])).rows[0];
    if(!job) fail(404,'Job not found.');
    if(job.status!=='open'||!job.in_time) fail(400,'This job is no longer accepting applications.');
    if(Number(student.cgpa)<Number(job.min_cgpa)) fail(400,'Your CGPA does not meet this job’s requirement.');
    if(job.eligible_branches.length&&!job.eligible_branches.includes(student.branch)) fail(400,'Your branch is not eligible for this job.');
    await connection.query('INSERT INTO applications(student_id,job_id) VALUES($1,$2)',[student.student_id,job.job_id]);
    await notify(connection,student.user_id,`Your application for ${job.job_title} was submitted.`);
    await notify(connection,job.company_user_id,`${req.user.full_name} applied for ${job.job_title}.`);
  });res.status(201).json({ok:true});
});
app.patch('/api/applications/:id/status',auth,role('admin','company'),async(req,res)=>{
  const status=z.object({status:z.enum(['applied','shortlisted','rejected','selected'])}).parse(req.body).status;
  await transaction(async connection=>{
    const row=await ownedApplication(connection,id.parse(req.params.id),req.user);
    const offer=await connection.query('SELECT offer_id FROM offers WHERE application_id=$1',[row.application_id]);
    if(offer.rowCount&&status!=='selected') fail(409,'An offer has already been issued for this application.');
    await connection.query('UPDATE applications SET status=$1 WHERE application_id=$2',[status,row.application_id]);
    await notify(connection,row.student_user_id,`Your ${row.company_name} application for ${row.job_title} is ${status}.`);
  });res.json({ok:true});
});
app.post('/api/interviews',auth,role('admin','company'),async(req,res)=>{
  const input=z.object({application_id:id,round_name:name,scheduled_at:z.iso.datetime({offset:true}),venue:z.string().trim().min(2).max(200)}).parse(req.body);
  if(Date.parse(input.scheduled_at)<=Date.now()) fail(400,'Choose a future interview time.');
  await transaction(async connection=>{
    const row=await ownedApplication(connection,input.application_id,req.user);
    if(row.status!=='shortlisted') fail(400,'Shortlist the application before scheduling an interview.');
    await connection.query('INSERT INTO interviews(application_id,round_name,scheduled_at,venue) VALUES($1,$2,$3,$4)',[input.application_id,input.round_name,input.scheduled_at,input.venue]);
    await notify(connection,row.student_user_id,`${input.round_name} scheduled for ${row.job_title}. Check your interviews for the time and venue.`);
  });res.status(201).json({ok:true});
});
app.patch('/api/interviews/:id',auth,role('admin','company'),async(req,res)=>{
  const input=z.object({status:z.enum(['scheduled','passed','failed','cancelled']),feedback:z.string().trim().max(2000).default('')}).parse(req.body);
  await transaction(async connection=>{
    const interview=(await connection.query('SELECT * FROM interviews WHERE interview_id=$1',[id.parse(req.params.id)])).rows[0];
    if(!interview) fail(404,'Interview not found.');
    const row=await ownedApplication(connection,interview.application_id,req.user);
    await connection.query('UPDATE interviews SET status=$1,feedback=$2 WHERE interview_id=$3',[input.status,input.feedback,interview.interview_id]);
    await notify(connection,row.student_user_id,`Your ${interview.round_name} interview result is ${input.status}.`);
  });res.json({ok:true});
});
app.post('/api/offers',auth,role('admin','company'),async(req,res)=>{
  const input=z.object({application_id:id,package_amount:z.coerce.number().positive().max(9999999999)}).parse(req.body);
  await transaction(async connection=>{
    const row=await ownedApplication(connection,input.application_id,req.user);
    if(row.status!=='selected') fail(400,'Mark the application selected before issuing an offer.');
    await connection.query('INSERT INTO offers(application_id,package_amount) VALUES($1,$2)',[input.application_id,input.package_amount]);
    await notify(connection,row.student_user_id,`Congratulations! ${row.company_name} has sent you an offer for ${row.job_title}.`);
  });res.status(201).json({ok:true});
});
app.patch('/api/offers/:id/respond',auth,role('student'),async(req,res)=>{
  const status=z.object({status:z.enum(['accepted','declined'])}).parse(req.body).status;
  await transaction(async connection=>{
    const result=await connection.query(`UPDATE offers o SET status=$1 FROM applications a,students s
      WHERE o.application_id=a.application_id AND a.student_id=s.student_id AND s.user_id=$2 AND o.offer_id=$3 AND o.status='pending' RETURNING o.application_id`,[status,req.user.user_id,id.parse(req.params.id)]);
    if(!result.rowCount) fail(409,'This offer is unavailable or has already been answered.');
    const company=(await connection.query('SELECT c.user_id FROM applications a JOIN jobs j USING(job_id) JOIN companies c USING(company_id) WHERE a.application_id=$1',[result.rows[0].application_id])).rows[0];
    await notify(connection,company.user_id,`${req.user.full_name} ${status} your offer.`);
  });res.json({ok:true});
});
app.patch('/api/notifications/read',auth,async(req,res)=>{
  await db.query('UPDATE notifications SET is_read=TRUE WHERE user_id=$1',[req.user.user_id]);res.json({ok:true});
});
app.get('/api/reports',auth,role('admin'),async(req,res)=>{
  const input=z.object({branch:z.string().max(100).optional(),company_id:id.optional(),graduation_year:year.optional(),status:z.enum(['pending','accepted','declined']).optional()}).parse(req.query);
  const rows=(await db.query(`SELECT u.full_name,s.roll_number,s.branch,s.graduation_year,c.company_name,j.job_title,o.package_amount,o.status,o.offer_date
    FROM offers o JOIN applications a USING(application_id) JOIN students s USING(student_id) JOIN users u ON u.user_id=s.user_id
    JOIN jobs j USING(job_id) JOIN companies c USING(company_id)
    WHERE ($1::text IS NULL OR s.branch=$1) AND ($2::int IS NULL OR c.company_id=$2)
    AND ($3::int IS NULL OR s.graduation_year=$3) AND ($4::text IS NULL OR o.status=$4)
    ORDER BY o.offer_date DESC,o.offer_id DESC`,[input.branch??null,input.company_id??null,input.graduation_year??null,input.status??null])).rows;
  res.json({rows});
});
app.use('/api',(req,res)=>res.status(404).json({error:'API route not found.'}));
app.use((error,req,res,next)=>{
  if(res.headersSent) return next(error);
  if(error instanceof z.ZodError) return res.status(400).json({error:error.issues.map(issue=>`${issue.path.join('.')}: ${issue.message}`).join('; ')});
  if(error.code==='23505') return res.status(409).json({error:'This email, roll number, application, or offer already exists.'});
  if(error.type==='entity.too.large') return res.status(413).json({error:'The uploaded certificate or request is too large. Certificate files must be at most 5 MB.'});
  if(error.type==='entity.parse.failed') return res.status(400).json({error:'Invalid JSON request.'});
  if(error.status) return res.status(error.status).json({error:error.message});
  console.error('Request failed:',error.code||error.message);
  res.status(500).json({error:'The request could not be completed. Please try again.'});
});
const port=Number(process.env.PORT||4000);
const server=app.listen(port,'127.0.0.1',()=>console.log(`CampusConnect API: http://127.0.0.1:${port}`));
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>server.close(()=>db.end().then(()=>process.exit(0))));
