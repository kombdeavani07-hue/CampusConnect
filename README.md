# CampusConnect

A local College Placement Management System for a DBMS project, built with React, Vite, Express, and PostgreSQL. Data persists in a real PostgreSQL database.

## Open and run on this Windows laptop

Open this `campusconnect` folder in VS Code. In its PowerShell terminal, run:

```powershell
npm.cmd run dev
```

This starts the dedicated PostgreSQL cluster, creates any missing tables and demo records, then runs the API and website. Open the **Network URL printed in the terminal**. Keep the terminal open; press Ctrl+C to stop the website and API. The database may remain running; stop it with `npm.cmd --prefix server run db:stop` when finished.

If dependencies need reinstalling:

```powershell
npm.cmd install
npm.cmd --prefix client install
npm.cmd --prefix server install
```

## Demo accounts

Use the Student, Company, and Admin buttons on the sign-in screen, or sign in manually. All demo accounts use the password `Campus@123`.

| Role | Email |
| --- | --- |
| Student | student@campusconnect.local |
| Approved company | company@campusconnect.local |
| Placement administrator | admin@campusconnect.local |
| Additional company | pending@campusconnect.local |

These are local demonstration accounts. Production deployment would require replacing demo credentials and configuring HTTPS, secret management, backups, and account recovery.

## Try the complete flow

1. Sign in as Student and apply to a job.
2. Sign out, then sign in as Company. Open Applications and change the status to `shortlisted`.
3. Choose **Schedule round**, enter a future time and a venue, and save.
4. Open Interviews and record the result. Return to Applications and mark the student `selected`.
5. Choose **Issue offer** and enter an annual package in rupees.
6. Sign in as Student, open Offers, and accept the offer.
7. Sign in as Admin to see the placed-student total and filter/export Placement reports.

For a new account, register as a student or company. The administrator verifies students before they can apply. Company accounts can post jobs and manage their own recruitment workflow without administrator approval. Admins can also add students and edit their academic records. Companies can edit their own jobs; admins can edit all jobs. Eligibility criteria become fixed after the first application.

## Folder map

```text
campusconnect/
  client/
    src/App.jsx          React screens and forms
    src/styles.css       Responsive styles
    src/CareerProfile.jsx Career editor and recruiter profile viewer
    src/main.jsx         React entry point
    vite.config.js       Development API proxy
  server/
    src/index.js         Authentication, permissions, API routes
    scripts/local-db.mjs Local PostgreSQL lifecycle
    scripts/migrate.mjs  Schema initialization and demo seed
    scripts/verify.mjs   Workflow and authorization checks
    .env                 Local database credentials and session secret (ignored)
  database/
    schema.sql           Eight tables, constraints, and indexes
    queries.sql          Useful DBMS demonstration queries
  .local/postgres/        Persistent local database files (ignored)
```

## Database connection

The project uses the installed PostgreSQL 18 tools to run a dedicated cluster under `.local/postgres`, listening only on **127.0.0.1:5434**. It leaves the existing PostgreSQL installation on port 5432 alone. Username: `campusconnect`; database: `campusconnect`. A random password is generated and saved in the ignored `server/.env` file. Do not share that file.

In pgAdmin, register a server using that host, port, username, and database. Read the password locally from the `DATABASE_URL` in `server/.env`. The password is the part between `campusconnect:` and `@127.0.0.1`. Set `POSTGRES_BIN` if your PostgreSQL executables are installed somewhere other than `C:\Program Files\PostgreSQL\18\bin`.

The sixteen tables include the eight core tables (`users`, `students`, `companies`, `jobs`, `applications`, `interviews`, `offers`, `notifications`) and eight career-profile tables (`skills`, `student_skills`, `domains`, `student_interests`, `job_roles`, `student_job_preferences`, `certifications`, `job_skills`). Students and jobs have a many-to-many relationship through `applications`. A unique constraint on `(student_id, job_id)` prevents duplicate applications, including simultaneous requests. Offers are unique per application. Foreign keys, checks, and transactions preserve data consistency.

## Verification

With the application running, use a second terminal:

```powershell
npm.cmd run verify
npm.cmd run build
```

Verification uses temporary accounts, tests the real API and database, and removes its own records afterward. It covers role permissions, eligibility, duplicate applications, interviews, offers, notifications, and filtered placement queries. The build command creates the frontend production bundle. This project currently targets local use; the report, email automation, resume uploads, and account recovery are separate future work.

## Wi-Fi access

Run `npm.cmd run dev` while connected to Wi-Fi. The website and API automatically detect the active Wi-Fi IPv4 address using `scripts/network.mjs`; the terminal prints the correct phone link. No IP edits in package.json or server/.env are needed. After switching Wi-Fi networks, stop the app with Ctrl+C and run the same command again. The website binds only to the detected address, and login requests are allowed from that exact origin. Existing CLIENT_ORIGIN entries in old .env files are ignored.

If no Wi-Fi address is active, startup explains how to connect. If multiple Wi-Fi addresses are active or the adapter has a custom name, set CAMPUS_HOST to an IPv4 address assigned to this laptop. Both phone and laptop must use the same Wi-Fi, and that network must allow device-to-device connections.

## Student career profiles

After registering as a student, you are taken to My profile. Existing students can open My profile from the sidebar or top-right account menu. Academic details remain managed by the placement cell. College email is collected at registration; email ownership verification is not yet implemented.

Add up to 30 skills with beginner, intermediate, or advanced proficiency, up to 15 preferred domains, and up to 15 preferred job roles. Save career profile to persist changes. These values use normalized catalogs and many-to-many student associations. Changes do not reset academic verification.

Add up to 50 certifications with a course name, issuer, optional completion date, credential ID, and HTTP/HTTPS credential URL. Each record can include one PDF, PNG, or JPEG document of at most 5 MB. Certificates can be edited, replaced, removed, or downloaded. Their bytes are stored in PostgreSQL BYTEA columns, alongside metadata; uploads are not exposed as public static files. Metadata and file changes are saved in a transaction.

Recruiters can choose View career profile from an application to their own job; they can read that student’s skills, interests, role preferences, and certifications, and download the certificate files. Administrators can open any student’s career profile. Other students and unrelated recruiters cannot access those profiles or files. Recruiters see the current saved career profile, not an immutable application-time snapshot.

Job forms support optional relevant skill tags. Student opportunity cards show how many listed skills match their own profile. Skill tags are recommendations; branch, CGPA, verification, deadline, and job status remain the mandatory application rules.
