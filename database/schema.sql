CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  full_name VARCHAR(100) NOT NULL,
  email VARCHAR(254) NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash TEXT NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('student','company','admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS students (
  student_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(user_id),
  roll_number VARCHAR(30) NOT NULL UNIQUE,
  branch VARCHAR(100) NOT NULL,
  graduation_year INTEGER NOT NULL CHECK (graduation_year BETWEEN 2000 AND 2100),
  cgpa NUMERIC(4,2) NOT NULL CHECK (cgpa BETWEEN 0 AND 10),
  verified BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS companies (
  company_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(user_id),
  company_name VARCHAR(150) NOT NULL,
  website TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS jobs (
  job_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(company_id),
  job_title VARCHAR(150) NOT NULL,
  description TEXT NOT NULL,
  location VARCHAR(100) NOT NULL,
  min_cgpa NUMERIC(4,2) NOT NULL CHECK (min_cgpa BETWEEN 0 AND 10),
  salary NUMERIC(12,2) NOT NULL CHECK (salary > 0),
  eligible_branches TEXT[] NOT NULL DEFAULT '{}',
  deadline DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS applications (
  application_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(student_id),
  job_id INTEGER NOT NULL REFERENCES jobs(job_id),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status VARCHAR(20) NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','shortlisted','rejected','selected')),
  UNIQUE (student_id,job_id)
);
CREATE TABLE IF NOT EXISTS interviews (
  interview_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(application_id),
  round_name VARCHAR(100) NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  venue VARCHAR(200) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','passed','failed','cancelled')),
  feedback TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS offers (
  offer_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  application_id INTEGER NOT NULL UNIQUE REFERENCES applications(application_id),
  package_amount NUMERIC(12,2) NOT NULL CHECK (package_amount > 0),
  offer_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined'))
);
CREATE TABLE IF NOT EXISTS notifications (
  notification_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(user_id),
  message TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS applications_job_idx ON applications(job_id);
CREATE INDEX IF NOT EXISTS jobs_company_idx ON jobs(company_id);
CREATE INDEX IF NOT EXISTS interviews_application_idx ON interviews(application_id);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id,created_at DESC);

-- Career profiles: normalized catalogs and many-to-many relationships.
CREATE TABLE IF NOT EXISTS skills (
  skill_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name VARCHAR(80) NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 80)
);
CREATE UNIQUE INDEX IF NOT EXISTS skills_name_unique ON skills (lower(name));
CREATE TABLE IF NOT EXISTS student_skills (
  student_id INTEGER NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  skill_id INTEGER NOT NULL REFERENCES skills(skill_id),
  proficiency VARCHAR(20) NOT NULL CHECK (proficiency IN ('beginner','intermediate','advanced')),
  PRIMARY KEY (student_id,skill_id)
);
CREATE TABLE IF NOT EXISTS domains (
  domain_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name VARCHAR(80) NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 80)
);
CREATE UNIQUE INDEX IF NOT EXISTS domains_name_unique ON domains (lower(name));
CREATE TABLE IF NOT EXISTS student_interests (
  student_id INTEGER NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  domain_id INTEGER NOT NULL REFERENCES domains(domain_id),
  PRIMARY KEY (student_id,domain_id)
);
CREATE TABLE IF NOT EXISTS job_roles (
  role_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name VARCHAR(80) NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 80)
);
CREATE UNIQUE INDEX IF NOT EXISTS job_roles_name_unique ON job_roles (lower(name));
CREATE TABLE IF NOT EXISTS student_job_preferences (
  student_id INTEGER NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES job_roles(role_id),
  PRIMARY KEY (student_id,role_id)
);
CREATE TABLE IF NOT EXISTS certifications (
  certification_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  course_name VARCHAR(200) NOT NULL,
  issuer VARCHAR(150) NOT NULL,
  completed_on DATE,
  credential_id VARCHAR(150) NOT NULL DEFAULT '',
  credential_url TEXT NOT NULL DEFAULT '',
  document BYTEA,
  document_name VARCHAR(200),
  document_type VARCHAR(50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (document IS NULL AND document_name IS NULL AND document_type IS NULL) OR
    (document IS NOT NULL AND document_name IS NOT NULL AND document_type IS NOT NULL AND
     octet_length(document) BETWEEN 1 AND 5242880 AND
     document_type IN ('application/pdf','image/png','image/jpeg'))
  )
);
CREATE INDEX IF NOT EXISTS certifications_student_idx ON certifications(student_id);
CREATE TABLE IF NOT EXISTS job_skills (
  job_id INTEGER NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
  skill_id INTEGER NOT NULL REFERENCES skills(skill_id),
  PRIMARY KEY (job_id,skill_id)
);
-- Additive recruitment improvements; existing accounts and applications are preserved.
CREATE TABLE IF NOT EXISTS company_invitations (
  invitation_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email VARCHAR(254) NOT NULL,
  company_name VARCHAR(150) NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by INTEGER NOT NULL REFERENCES users(user_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS student_resumes (
  student_id INTEGER PRIMARY KEY REFERENCES students(student_id) ON DELETE CASCADE,
  document BYTEA NOT NULL CHECK (octet_length(document) BETWEEN 1 AND 5242880),
  document_name VARCHAR(200) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS drive_date DATE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS drive_venue VARCHAR(200) NOT NULL DEFAULT '';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS selection_rounds VARCHAR(1000) NOT NULL DEFAULT '';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS drive_instructions VARCHAR(3000) NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS applications_job_status_idx ON applications(job_id,status,application_id);
CREATE INDEX IF NOT EXISTS students_cohort_idx ON students(branch,graduation_year,student_id);
CREATE INDEX IF NOT EXISTS invitations_email_idx ON company_invitations(email);
