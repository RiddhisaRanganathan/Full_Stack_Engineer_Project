import pg from 'pg';
import {config} from './config.js';
export const pool = new pg.Pool({connectionString:config.database,max:config.poolMax,connectionTimeoutMillis:2000,statement_timeout:5000,idleTimeoutMillis:30000});
pool.on('error', e=>console.error(JSON.stringify({event:'idle_db_error',message:e.message})));
export async function transaction(fn) {
 const c=await pool.connect();
 try { await c.query('BEGIN'); const result=await fn(c); await c.query('COMMIT'); return result; }
 catch(e) { await c.query('ROLLBACK').catch(()=>{}); throw e; }
 finally { c.release(); }
}
