import { randomBytes,createHash } from 'node:crypto';
import { z } from 'zod';
export const tokenHash=value=>createHash('sha256').update(value).digest('hex');
const querySchema=z.object({page:z.coerce.number().int().min(1).default(1),page_size:z.coerce.number().int().min(1).max(100).default(20),search:z.string().trim().max(100).default(''),job_id:z.coerce.number().int().positive().optional(),status:z.enum(['applied','shortlisted','rejected','selected']).optional(),branch:z.string().max(100).optional(),graduation_year:z.coerce.number().int().min(2000).max(2100).optional(),min_cgpa:z.coerce.number().min(0).max(10).optional(),skill:z.string().trim().max(80).optional()});
export function registerRecruitmentRoutes(app,{db,auth,role,fail,id}) {
 app.post('/api/company-invitations',auth,role('admin'),async(req,res)=>{
  const input=z.object({email:z.email().max(254).transform(v=>v.toLowerCase()),company_name:z.string().trim().min(2).max(150)}).parse(req.body);
  if((await db.query('SELECT 1 FROM users WHERE email=$1',[input.email])).rowCount)fail(409,'An account already uses this email.');
  const token=randomBytes(32).toString('hex');
  const row=(await db.query('INSERT INTO company_invitations(email,company_name,token_hash,created_by) VALUES($1,$2,$3,$4) RETURNING invitation_id,email,company_name,expires_at',[input.email,input.company_name,tokenHash(token),req.user.user_id])).rows[0];
  res.status(201).json({invitation:row,token});
 });
 app.get('/api/company-invitations',auth,role('admin'),async(req,res)=>res.json({rows:(await db.query('SELECT invitation_id,email,company_name,created_at,expires_at,used_at,revoked_at FROM company_invitations ORDER BY invitation_id DESC LIMIT 100')).rows}));
 app.delete('/api/company-invitations/:id',auth,role('admin'),async(req,res)=>{
  const result=await db.query('UPDATE company_invitations SET revoked_at=NOW() WHERE invitation_id=$1 AND used_at IS NULL AND revoked_at IS NULL RETURNING invitation_id',[id.parse(req.params.id)]);
  if(!result.rowCount)fail(404,'Invitation is unavailable or already used.');res.json({ok:true});
 });
 async function applicants(req,exporting=false){
  const q=querySchema.parse(req.query);
  const values=[req.user.role,req.user.user_id,q.job_id??null,q.status??null,q.branch??null,q.graduation_year??null,q.min_cgpa??null,q.skill??null,'%'+q.search+'%'];
  const from=String.raw`FROM applications a JOIN jobs j USING(job_id) JOIN companies c USING(company_id) JOIN students s USING(student_id) JOIN users u ON u.user_id=s.user_id
   WHERE ($1='admin' OR c.user_id=$2) AND ($3::int IS NULL OR j.job_id=$3) AND ($4::text IS NULL OR a.status=$4)
   AND ($5::text IS NULL OR s.branch=$5) AND ($6::int IS NULL OR s.graduation_year=$6) AND ($7::numeric IS NULL OR s.cgpa >= $7)
   AND ($8::text IS NULL OR EXISTS(SELECT 1 FROM student_skills sk JOIN skills k USING(skill_id) WHERE sk.student_id=s.student_id AND k.name ILIKE '%'||$8||'%'))
   AND (u.full_name ILIKE $9 OR u.email ILIKE $9 OR s.roll_number ILIKE $9 OR j.job_title ILIKE $9 OR s.branch ILIKE $9)`;
  const fields='a.*,j.job_title,j.salary,c.company_name,u.full_name,u.email,s.roll_number,s.branch,s.cgpa,s.graduation_year,EXISTS(SELECT 1 FROM student_resumes r WHERE r.student_id=s.student_id) AS has_resume';
  const total=Number((await db.query('SELECT COUNT(*) '+from,values)).rows[0].count);
  if(exporting)return {rows:(await db.query('SELECT '+fields+' '+from+' ORDER BY a.applied_at DESC,a.application_id DESC',values)).rows};
  const rows=(await db.query('SELECT '+fields+' '+from+' ORDER BY a.applied_at DESC,a.application_id DESC LIMIT $10 OFFSET $11',[...values,q.page_size,(q.page-1)*q.page_size])).rows;
  return {rows,total,page:q.page,page_size:q.page_size};
 }
 app.get('/api/applicants',auth,role('company','admin'),async(req,res)=>res.json(await applicants(req)));
 app.get('/api/applicants/export',auth,role('company','admin'),async(req,res)=>{
  const {rows}=await applicants(req,true);
  const keys=['full_name','email','roll_number','branch','graduation_year','cgpa','company_name','job_title','status','applied_at'];
  const cell=v=>{let s=String(v??'');if(/^[\s]*[=+@\-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  res.set('Cache-Control','private, no-store').attachment('campusconnect-applicants.csv').type('text/csv').send('\uFEFF'+[keys,...rows.map(row=>keys.map(k=>row[k]))].map(row=>row.map(cell).join(',')).join('\r\n'));
 });
 app.get('/api/student-directory',auth,role('admin'),async(req,res)=>{
  const q=querySchema.parse(req.query),values=['%'+q.search+'%'];
  const where='FROM students s JOIN users u USING(user_id) WHERE (u.full_name ILIKE $1 OR u.email ILIKE $1 OR s.roll_number ILIKE $1 OR s.branch ILIKE $1)';
  const total=Number((await db.query('SELECT COUNT(*) '+where,values)).rows[0].count);
  const rows=(await db.query('SELECT s.*,u.full_name,u.email '+where+' ORDER BY s.student_id DESC LIMIT $2 OFFSET $3',[...values,q.page_size,(q.page-1)*q.page_size])).rows;
  res.json({rows,total,page:q.page,page_size:q.page_size});
 });
}
