import {readFile} from 'node:fs/promises';
import {pool,transaction} from './db.js';
try { await transaction(async c=>{await c.query('SELECT pg_advisory_xact_lock(823419)'); await c.query(await readFile(new URL('../migrations/001.sql',import.meta.url),'utf8'));}); console.log('Migration complete'); }
finally {await pool.end();}
