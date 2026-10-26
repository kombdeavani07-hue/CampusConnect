import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
if (!process.env.DATABASE_URL) throw new Error('Configure server/.env before initializing the database.');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  await db.query('BEGIN');
  await db.query(readFileSync(new URL('../../database/schema.sql', import.meta.url), 'utf8'));
  const hash = await bcrypt.hash('Campus@123', 12);
  async function account(name, email, role) {
    const result = await db.query('INSERT INTO users(full_name,email,password_hash,role) VALUES($1,$2,$3,$4) ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING user_id', [name,email,hash,role]);
    return result.rows[0].user_id;
  }
  await account('Ananya Rao', 'admin@campusconnect.local', 'admin');
  const student = await account('Arjun Mehta', 'student@campusconnect.local', 'student');
  const student2 = await account('Priya Sharma', 'priya@campusconnect.local', 'student');
  await db.query("INSERT INTO students(user_id,roll_number,branch,graduation_year,cgpa,verified) VALUES ($1,'CS2023001','Computer Science',2027,8.6,TRUE),($2,'EC2023002','Electronics',2027,8.1,TRUE) ON CONFLICT(user_id) DO NOTHING", [student,student2]);
  const company = await account('Neha Kapoor', 'company@campusconnect.local', 'company');
  const pending = await account('Vikram Das', 'pending@campusconnect.local', 'company');
  await db.query("INSERT INTO companies(user_id,company_name,website,approval_status) VALUES ($1,'Northstar Technologies','https://example.com','approved'),($2,'Vertex Labs','https://example.org','pending') ON CONFLICT(user_id) DO NOTHING", [company,pending]);
  const c = (await db.query('SELECT company_id FROM companies WHERE user_id=$1', [company])).rows[0].company_id;
  const jobCount = await db.query('SELECT COUNT(*) FROM jobs WHERE company_id=$1', [c]);
  if (Number(jobCount.rows[0].count) === 0) {
    await db.query(`INSERT INTO jobs(company_id,job_title,description,location,min_cgpa,salary,eligible_branches,deadline) VALUES
      ($1,'Graduate Software Engineer','Build thoughtful web applications with a collaborative engineering team. Work across APIs, databases, and modern interfaces. Strong fundamentals and a willingness to learn matter most.','Bengaluru',7.5,900000,ARRAY['Computer Science','Information Technology'],CURRENT_DATE+21),
      ($1,'Data Analyst','Turn complex datasets into useful decisions. Use SQL, statistics, and clear communication to help product teams understand their customers.','Hyderabad',7.0,650000,ARRAY[]::TEXT[],CURRENT_DATE+14),
      ($1,'Quality Engineering Associate','Help teams ship reliable software. Explore workflows, document bugs, and develop automated checks with experienced mentors.','Pune',6.5,550000,ARRAY[]::TEXT[],CURRENT_DATE+30)`, [c]);
    await db.query("INSERT INTO notifications(user_id,message) SELECT user_id,'Welcome to CampusConnect. Your next opportunity starts here.' FROM users");
  }
  await db.query('COMMIT');
  console.log('Database tables and demonstration accounts are ready. Existing records were preserved.');
} catch (error) { await db.query('ROLLBACK'); throw error; }
finally { await db.end(); }
