import express from 'express';
import { z } from 'zod';

const label = z.string().trim().min(2).max(80);
const validDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value, 'Enter a valid date.');
const httpUrl = z.union([z.literal(''),z.url().max(2000).refine(value => /^https?:\/\//i.test(value),'Use an HTTP or HTTPS URL.')]);
const profileSchema = z.object({
  skills: z.array(z.object({name:label,proficiency:z.enum(['beginner','intermediate','advanced'])})).max(30),
  interests: z.array(label).max(15),
  preferred_roles: z.array(label).max(15)
});
const documentSchema = z.object({name:z.string().trim().min(1).max(200),type:z.enum(['application/pdf','image/png','image/jpeg']),data:z.string().min(4).max(6990508)});
const certificationSchema = z.object({
  course_name:z.string().trim().min(2).max(200),issuer:z.string().trim().min(2).max(150),
  completed_on:validDate.nullable().default(null),credential_id:z.string().trim().max(150).default(''),
  credential_url:httpUrl.default(''),document:documentSchema.nullable().optional()
});
const certColumns = `certification_id,student_id,course_name,issuer,completed_on,credential_id,credential_url,
  (document IS NOT NULL) AS has_document,document_name,document_type,created_at,updated_at`;

// Catalog/table identifiers below are fixed by the caller, never supplied by a request.
export async function catalogId(connection, catalog, name) {
  const keys={skills:'skill_id',domains:'domain_id',job_roles:'role_id'};
  if(!keys[catalog])throw new Error('Unknown catalog.');
  const result=await connection.query(`INSERT INTO ${catalog}(name) VALUES($1)
    ON CONFLICT (lower(name)) DO UPDATE SET name=${catalog}.name RETURNING ${keys[catalog]} AS id`,[name]);
  return result.rows[0].id;
}
export async function saveJobSkills(connection,jobId,names) {
  await connection.query('DELETE FROM job_skills WHERE job_id=$1',[jobId]);
  for(const name of [...new Map(names.map(value=>[value.toLowerCase(),value])).values()].sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase()))) {
    const skill=await catalogId(connection,'skills',name);
    await connection.query('INSERT INTO job_skills(job_id,skill_id) VALUES($1,$2)',[jobId,skill]);
  }
}
function decodeDocument(input,fail) {
  if(!/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)||input.data.length%4!==0)fail(400,'Invalid certificate file encoding.');
  const bytes=Buffer.from(input.data,'base64');
  if(!bytes.length||bytes.length>5*1024*1024)fail(400,'Certificates must be at most 5 MB.');
  const valid=(input.type==='application/pdf'&&bytes.subarray(0,5).toString()==='%PDF-') ||
    (input.type==='image/png'&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) ||
    (input.type==='image/jpeg'&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255);
  if(!valid)fail(400,'The file must be a valid PDF, PNG, or JPEG matching its selected type.');
  return {bytes,name:input.name.replace(/[\x00-\x1f\x7f\\/]/g,'_'),type:input.type};
}
export function registerCareerRoutes(app,{db,auth,role,transaction,fail,id}) {
  // Larger request bodies are allowed only for authenticated certificate writes.
  const router=express.Router();
  app.use('/api/career',router);
  router.use(auth);
  router.use(express.json({limit:'8mb'}));
  async function ownStudent(connection,user,lock=false) {
    const row=(await connection.query('SELECT student_id FROM students WHERE user_id=$1'+(lock?' FOR UPDATE':''),[user.user_id])).rows[0];
    if(!row)fail(404,'Student profile not found.');
    return row.student_id;
  }
  async function permittedStudent(connection,studentId,user) {
    const result=await connection.query(`SELECT s.*,u.full_name,u.email FROM students s JOIN users u USING(user_id)
      WHERE s.student_id=$1 AND ($2='admin' OR s.user_id=$3 OR ($2='company' AND EXISTS (
        SELECT 1 FROM applications a JOIN jobs j USING(job_id) JOIN companies c USING(company_id)
        WHERE a.student_id=s.student_id AND c.user_id=$3)))`,[studentId,user.role,user.user_id]);
    if(!result.rowCount)fail(404,'Student profile is not available to your account.');
    return result.rows[0];
  }
  async function profile(studentId,user) {
    return transaction(async connection=>{
      const student=await permittedStudent(connection,studentId,user);
      const skills=(await connection.query('SELECT k.skill_id,k.name,ss.proficiency FROM student_skills ss JOIN skills k USING(skill_id) WHERE ss.student_id=$1 ORDER BY lower(k.name)',[studentId])).rows;
      const interests=(await connection.query('SELECT d.domain_id,d.name FROM student_interests si JOIN domains d USING(domain_id) WHERE si.student_id=$1 ORDER BY lower(d.name)',[studentId])).rows;
      const preferred_roles=(await connection.query('SELECT r.role_id,r.name FROM student_job_preferences sp JOIN job_roles r USING(role_id) WHERE sp.student_id=$1 ORDER BY lower(r.name)',[studentId])).rows;
      const certifications=(await connection.query(`SELECT ${certColumns} FROM certifications WHERE student_id=$1 ORDER BY completed_on DESC NULLS LAST,certification_id DESC`,[studentId])).rows;
      const resume=(await connection.query('SELECT document_name,updated_at FROM student_resumes WHERE student_id=$1',[studentId])).rows[0]||null;
      return {student,skills,interests,preferred_roles,certifications,resume};
    });
  }
  router.get('/me',role('student'),async(req,res)=>res.json(await profile(await ownStudent(db,req.user),req.user)));
  router.get('/students/:id',async(req,res)=>res.json(await profile(id.parse(req.params.id),req.user)));
  router.put('/resume',role('student'),async(req,res)=>{
    const input=z.object({name:z.string().trim().min(1).max(200),type:z.literal('application/pdf'),data:z.string().min(4).max(6990508)}).parse(req.body);
    const document=decodeDocument(input,fail);
    const studentId=await ownStudent(db,req.user);
    await db.query('INSERT INTO student_resumes(student_id,document,document_name) VALUES($1,$2,$3) ON CONFLICT(student_id) DO UPDATE SET document=EXCLUDED.document,document_name=EXCLUDED.document_name,updated_at=NOW()',[studentId,document.bytes,document.name]);
    res.json({ok:true});
  });
  router.delete('/resume',role('student'),async(req,res)=>{await db.query('DELETE FROM student_resumes WHERE student_id=$1',[await ownStudent(db,req.user)]);res.json({ok:true});});
  router.get('/students/:id/resume',async(req,res)=>{
    const studentId=id.parse(req.params.id);await permittedStudent(db,studentId,req.user);
    const row=(await db.query('SELECT document,document_name FROM student_resumes WHERE student_id=$1',[studentId])).rows[0];
    if(!row)fail(404,'No resume has been uploaded.');
    res.set('Content-Type','application/pdf').set('Cache-Control','private, no-store').set('Content-Disposition',"attachment; filename=resume.pdf; filename*=UTF-8''"+encodeURIComponent(row.document_name).replace(/'/g,'%27')).send(row.document);
  });
  router.put('/me',role('student'),async(req,res)=>{
    const input=profileSchema.parse(req.body);
    const unique=items=>new Set(items.map(value=>value.toLowerCase())).size===items.length;
    if(!unique(input.skills.map(value=>value.name))||!unique(input.interests)||!unique(input.preferred_roles))fail(400,'Each skill, domain, and preferred role must be listed only once.');
    await transaction(async connection=>{
      const studentId=await ownStudent(connection,req.user,true);
      await connection.query('DELETE FROM student_skills WHERE student_id=$1',[studentId]);
      await connection.query('DELETE FROM student_interests WHERE student_id=$1',[studentId]);
      await connection.query('DELETE FROM student_job_preferences WHERE student_id=$1',[studentId]);
      // Deterministic catalog ordering avoids opposite-order upsert deadlocks.
      for(const skill of [...input.skills].sort((a,b)=>a.name.toLowerCase().localeCompare(b.name.toLowerCase()))) {
        const skillId=await catalogId(connection,'skills',skill.name);
        await connection.query('INSERT INTO student_skills(student_id,skill_id,proficiency) VALUES($1,$2,$3)',[studentId,skillId,skill.proficiency]);
      }
      for(const domain of [...input.interests].sort()) {
        const domainId=await catalogId(connection,'domains',domain);
        await connection.query('INSERT INTO student_interests(student_id,domain_id) VALUES($1,$2)',[studentId,domainId]);
      }
      for(const preference of [...input.preferred_roles].sort()) {
        const roleId=await catalogId(connection,'job_roles',preference);
        await connection.query('INSERT INTO student_job_preferences(student_id,role_id) VALUES($1,$2)',[studentId,roleId]);
      }
    });
    res.json({ok:true});
  });
  async function saveCertification(req,res,editing) {
    const input=certificationSchema.parse(req.body);
    const document=input.document?decodeDocument(input.document,fail):null;
    const result=await transaction(async connection=>{
      const studentId=await ownStudent(connection,req.user,true);
      if(input.completed_on){const today=(await connection.query('SELECT CURRENT_DATE::text AS today')).rows[0].today;if(input.completed_on>today)fail(400,'Completion date cannot be in the future.');}
      let certificationId;
      if(editing){
        certificationId=id.parse(req.params.id);
        const exists=await connection.query('SELECT 1 FROM certifications WHERE certification_id=$1 AND student_id=$2 FOR UPDATE',[certificationId,studentId]);
        if(!exists.rowCount)fail(404,'Certification not found.');
        await connection.query('UPDATE certifications SET course_name=$1,issuer=$2,completed_on=$3,credential_id=$4,credential_url=$5,updated_at=NOW() WHERE certification_id=$6',[input.course_name,input.issuer,input.completed_on,input.credential_id,input.credential_url,certificationId]);
      }else{
        const count=(await connection.query('SELECT COUNT(*)::int AS count FROM certifications WHERE student_id=$1',[studentId])).rows[0].count;
        if(count>=50)fail(400,'You can keep up to 50 certifications in your profile.');
        certificationId=(await connection.query('INSERT INTO certifications(student_id,course_name,issuer,completed_on,credential_id,credential_url) VALUES($1,$2,$3,$4,$5,$6) RETURNING certification_id',[studentId,input.course_name,input.issuer,input.completed_on,input.credential_id,input.credential_url])).rows[0].certification_id;
      }
      if(document)await connection.query('UPDATE certifications SET document=$1,document_name=$2,document_type=$3 WHERE certification_id=$4',[document.bytes,document.name,document.type,certificationId]);
      else if(input.document===null)await connection.query('UPDATE certifications SET document=NULL,document_name=NULL,document_type=NULL WHERE certification_id=$1',[certificationId]);
      return (await connection.query(`SELECT ${certColumns} FROM certifications WHERE certification_id=$1`,[certificationId])).rows[0];
    });
    res.status(editing?200:201).json({certification:result});
  }
  router.post('/certifications',role('student'),(req,res)=>saveCertification(req,res,false));
  router.patch('/certifications/:id',role('student'),(req,res)=>saveCertification(req,res,true));
  router.delete('/certifications/:id',role('student'),async(req,res)=>{
    const studentId=await ownStudent(db,req.user);
    const result=await db.query('DELETE FROM certifications WHERE certification_id=$1 AND student_id=$2',[id.parse(req.params.id),studentId]);
    if(!result.rowCount)fail(404,'Certification not found.');
    res.json({ok:true});
  });
  router.get('/certifications/:id/document',async(req,res)=>{
    const cert=(await db.query('SELECT student_id FROM certifications WHERE certification_id=$1',[id.parse(req.params.id)])).rows[0];
    if(!cert)fail(404,'Certificate not found.');
    await permittedStudent(db,cert.student_id,req.user);
    const row=(await db.query('SELECT document,document_name,document_type FROM certifications WHERE certification_id=$1',[id.parse(req.params.id)])).rows[0];
    if(!row?.document)fail(404,'No document has been uploaded for this certification.');
    res.set('Content-Type',row.document_type);
    res.set('Content-Disposition',`attachment; filename="certificate.${row.document_type==='application/pdf'?'pdf':row.document_type==='image/png'?'png':'jpg'}"; filename*=UTF-8''${encodeURIComponent(row.document_name).replace(/'/g,'%27')}`);
    res.set('Cache-Control','private, no-store');
    res.send(row.document);
  });
}