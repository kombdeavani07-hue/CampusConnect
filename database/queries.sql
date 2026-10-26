-- Run these in pgAdmin against the CampusConnect database.
-- SELECT / JOIN: students, accounts, jobs, companies, and applications.
SELECT u.full_name, s.roll_number, s.branch, s.cgpa,
       c.company_name, j.job_title, a.status
FROM applications a
JOIN students s USING (student_id)
JOIN users u ON u.user_id = s.user_id
JOIN jobs j USING (job_id)
JOIN companies c USING (company_id)
ORDER BY a.applied_at DESC;

-- GROUP BY / LEFT JOIN: include companies with no applications.
SELECT c.company_name, COUNT(DISTINCT j.job_id) AS job_count,
       COUNT(a.application_id) AS applications
FROM companies c
LEFT JOIN jobs j USING (company_id)
LEFT JOIN applications a USING (job_id)
GROUP BY c.company_id, c.company_name
ORDER BY applications DESC;

-- Aggregates: placement outcomes per branch and graduation year.
SELECT s.branch, s.graduation_year,
       COUNT(DISTINCT s.student_id) AS placed_students,
       ROUND(AVG(o.package_amount), 2) AS average_package,
       MAX(o.package_amount) AS highest_package
FROM offers o
JOIN applications a USING (application_id)
JOIN students s USING (student_id)
WHERE o.status = 'accepted'
GROUP BY s.branch, s.graduation_year
ORDER BY s.graduation_year, s.branch;

-- NOT EXISTS: verified students who have not applied anywhere yet.
SELECT u.full_name, s.roll_number, s.branch
FROM students s
JOIN users u USING (user_id)
WHERE s.verified
AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.student_id = s.student_id);

-- Verify the uniqueness constraint that prevents duplicate applications.
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'applications'::regclass;


-- Skills and proficiency for each student (normalized many-to-many relationship).
SELECT u.full_name, s.roll_number, k.name AS skill, sk.proficiency
FROM student_skills sk
JOIN students s USING (student_id)
JOIN users u USING (user_id)
JOIN skills k USING (skill_id)
ORDER BY s.roll_number, lower(k.name);

-- Find students who know Python, prefer Data Science, and have CGPA >= 7.5.
SELECT u.full_name, s.roll_number, s.branch, s.cgpa
FROM students s
JOIN users u USING (user_id)
WHERE s.cgpa >= 7.5
AND EXISTS (SELECT 1 FROM student_skills sk JOIN skills k USING (skill_id)
            WHERE sk.student_id=s.student_id AND lower(k.name)='python')
AND EXISTS (SELECT 1 FROM student_interests si JOIN domains d USING (domain_id)
            WHERE si.student_id=s.student_id AND lower(d.name)='data science');

-- Certification metadata and upload sizes; avoid selecting the binary documents.
SELECT u.full_name, c.course_name, c.issuer, c.completed_on, c.credential_url,
       c.document_name, octet_length(c.document) AS document_bytes
FROM certifications c
JOIN students s USING (student_id)
JOIN users u USING (user_id)
ORDER BY s.student_id, c.completed_on DESC NULLS LAST;

-- Match a student’s skills to the relevant skills tagged on a job.
SELECT s.roll_number, j.job_title, k.name AS matching_skill, sk.proficiency
FROM student_skills sk
JOIN students s USING (student_id)
JOIN job_skills jk USING (skill_id)
JOIN skills k USING (skill_id)
JOIN jobs j USING (job_id)
ORDER BY s.roll_number, j.job_id;
