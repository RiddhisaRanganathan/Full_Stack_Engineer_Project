import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {pool,transaction} from './db.js';
import {config} from './config.js';
export const digest = s=>createHash('sha256').update(s).digest('hex');
export function validate(body) {
 if(!Number.isInteger(body.quantity)||body.quantity<1||body.quantity>500) throw Object.assign(new Error('Quantity must be an integer from 1 to 500'),{status:400});
 const outcome=body.paymentOutcome||'success';
 if(!['success','decline','timeout'].includes(outcome)) throw Object.assign(new Error('Invalid simulated payment outcome'),{status:400});
 return {quantity:body.quantity,paymentOutcome:outcome};
}
export function identity(key,body) {return {hash:digest(JSON.stringify(body)),id:randomUUID(),token:randomBytes(24).toString('hex')};}
export async function existing(key,hash) {
 const {rows:[o]}=await pool.query('SELECT * FROM orders WHERE idem_key=$1',[key]);
 if(o&&o.payload_hash!==hash) throw Object.assign(new Error('Idempotency key already used with another payload'),{status:409});
 return o;
}
export async function enqueue(key,body,i) {
 return transaction(async c=>{
  // No inventory lock. One short capacity check prevents an unbounded durable inbox.
  await c.query('SELECT id FROM admission_lock WHERE id=1 FOR UPDATE');
  const {rows:[old]}=await c.query('SELECT * FROM orders WHERE idem_key=$1',[key]);
  if(old){if(old.payload_hash!==i.hash) throw Object.assign(new Error('Idempotency conflict'),{status:409}); return old;}
  const {rows:[{count}]}=await c.query("SELECT count(*)::int AS count FROM orders WHERE state IN ('queued','reserved')");
  if(count>=config.queueLimit) throw Object.assign(new Error('Durable inbox is full; retry with the same key'),{status:503});
  const {rows:[o]}=await c.query('INSERT INTO orders(id,idem_key,status_token,payload_hash,quantity,payment_outcome) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[i.id,key,i.token,i.hash,body.quantity,body.paymentOutcome]);
  await c.query('INSERT INTO dispatch(order_id) VALUES($1)',[o.id]);
  return o;
 });
}
export function view(o) {
 return {orderId:o.id,state:o.state,quantity:o.quantity,payment:o.payment_state,fulfillment:o.fulfillment_state,reason:o.reason,expiresAt:o.expires_at};
}
// Atomic stock movements; all callers first lock their own order, then inventory.
async function returnStock(c,o,state,reason,payment) {
 await c.query('UPDATE inventory SET available=available+$1,reserved=reserved-$1 WHERE id=1',[o.quantity]);
 await c.query('UPDATE orders SET state=$2,reason=$3,payment_state=$4,updated_at=now() WHERE id=$1',[o.id,state,reason,payment]);
}
export async function processOrder(id) {
 return transaction(async c=>{
  const {rows:[o]}=await c.query('SELECT *, now() AS db_now FROM orders WHERE id=$1 FOR UPDATE',[id]);
  if(!o) throw new Error('Unknown order');
  if(o.state==='queued') {
   const r=await c.query('UPDATE inventory SET available=available-$1,reserved=reserved+$1 WHERE id=1 AND available >= $1 RETURNING id',[o.quantity]);
   if(!r.rowCount) {await c.query("UPDATE orders SET state='rejected',reason='Insufficient stock',updated_at=now() WHERE id=$1",[id]); return 'rejected';}
   await c.query("UPDATE orders SET state='reserved',payment_state='pending',expires_at=now()+$2::double precision*interval '1 millisecond',next_attempt_at=now()+$3::double precision*interval '1 millisecond',updated_at=now() WHERE id=$1",[id,config.ttlMs,config.paymentMs]);
   return 'reserved';
  }
  if(o.state!=='reserved') return o.state;
  if(o.expires_at<=o.db_now) {await returnStock(c,o,'expired','Reservation expired','cancelled'); return 'expired';}
  if(o.next_attempt_at>o.db_now||o.payment_outcome==='timeout') return 'reserved';
  if(o.payment_outcome==='decline') {await returnStock(c,o,'failed','Simulated payment declined','declined'); return 'failed';}
  await c.query('UPDATE inventory SET reserved=reserved-$1,confirmed=confirmed+$1 WHERE id=1',[o.quantity]);
  await c.query("UPDATE orders SET state='confirmed',payment_state='paid',fulfillment_state='ready',updated_at=now() WHERE id=$1",[id]);
  return 'confirmed';
 });
}
export async function failAttempt(id,message) {
 await transaction(async c=>{
  const {rows:[o]}=await c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[id]);
  if(!o||!['queued','reserved'].includes(o.state))return;
  const n=o.attempts+1;
  if(n>=config.maxAttempts) {
   if(o.state==='reserved')await returnStock(c,o,'failed','Processing exhausted retries','cancelled');
   else await c.query("UPDATE orders SET state='failed',reason='Processing exhausted retries',updated_at=now() WHERE id=$1",[id]);
   await c.query('INSERT INTO dead_letters(order_id,reason) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,message.slice(0,500)]);
  }
  await c.query("UPDATE orders SET attempts=$2,next_attempt_at=now()+$3::double precision*interval '1 millisecond' WHERE id=$1",[id,n,Math.min(30000,250*2**n)*(0.5+Math.random())]);
 });
}
export async function reconcile() {
 // Audit, never overwrite authoritative inventory from Redis.
 const {rows:[r]}=await pool.query(`SELECT i.*, (SELECT coalesce(sum(quantity),0)::int FROM orders WHERE state='reserved') AS order_reserved,
 (SELECT coalesce(sum(quantity),0)::int FROM orders WHERE state='confirmed') AS order_confirmed FROM inventory i WHERE id=1`);
 if(r.reserved!==r.order_reserved||r.confirmed!==r.order_confirmed)throw new Error('INVENTORY INVARIANT VIOLATION: stop processing and investigate');
 return r;
}
export async function reapExpired() {
 return transaction(async c=>{
  const {rows}=await c.query("SELECT * FROM orders WHERE state='reserved' AND expires_at<=now() ORDER BY expires_at LIMIT 50 FOR UPDATE SKIP LOCKED");
  for(const o of rows)await returnStock(c,o,'expired','Reservation expired','cancelled');
  return rows.length;
 });
}
