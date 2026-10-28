import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
if(process.env.ALLOW_TEST_RESET!=='1')throw new Error('Tests reset the configured database: set ALLOW_TEST_RESET=1 only for a disposable database');
process.env.RESERVATION_TTL_MS='350';process.env.PAYMENT_DELAY_MS='20';process.env.SALE_START='2000-01-01T00:00:00Z';process.env.RATE_LIMIT='10000';process.env.PORT='3100';
const {pool}=await import('../src/db.js');
const {processOrder,reconcile,reapExpired}=await import('../src/orders.js');
const {redis,admit,release}=await import('../src/admission.js');
let children=[];
async function reset(){await pool.query('TRUNCATE dispatch,dead_letters,orders CASCADE');await pool.query('UPDATE inventory SET available=500,reserved=0,confirmed=0');await redis.del(['{sale}:leases','{sale}:quantities']);}
async function seed(q=1,outcome='success'){
 const id=randomUUID();await pool.query('INSERT INTO orders(id,idem_key,status_token,payload_hash,quantity,payment_outcome) VALUES($1::uuid,$1::text,$1::text,$1::text,$2,$3)',[id,q,outcome]);return id;
}
async function eventually(fn,ms=10000){const end=Date.now()+ms;let last;while(Date.now()<end){try{return await fn();}catch(e){last=e;await sleep(50);}}throw last;}
function child(file){const p=spawn(process.execPath,[file],{env:{...process.env,RESERVATION_TTL_MS:'5000'},stdio:['ignore','pipe','pipe']});let output='';p.stdout.on('data',b=>{output+=b;});p.stderr.on('data',b=>{output+=b;});p.on('exit',code=>{if(code&&code!==null)console.error(output);});children.push(p);return p;}
before(async()=>{await redis.connect();await reset();});
after(async()=>{for(const c of children)c.kill('SIGTERM');await Promise.all(children.map(c=>new Promise(r=>{if(c.exitCode!==null)return r();c.once('exit',r);setTimeout(()=>c.kill('SIGKILL'),5000).unref();})));await reset();await redis.quit();await pool.end();});
test('concurrent allocation never exceeds 500, duplicates do not double allocate',async()=>{
 const ids=await Promise.all(Array.from({length:120},()=>seed(5)));
 const states=await Promise.all(ids.map(processOrder));
 assert.equal(states.filter(x=>x==='reserved').length,100);assert.equal(states.filter(x=>x==='rejected').length,20);
 await Promise.all(Array.from({length:20},()=>processOrder(ids[0])));
 const r=await reconcile();assert.equal(r.available,0);assert.equal(r.reserved+r.confirmed,500);
 await reset();
});
test('multiple-unit orders allocate atomically and sell the final unit',async()=>{
 const a=await seed(237),b=await seed(263),c=await seed(1);
 assert.equal(await processOrder(a),'reserved');assert.equal(await processOrder(b),'reserved');assert.equal(await processOrder(c),'rejected');
 await sleep(25);assert.equal(await processOrder(a),'confirmed');assert.equal(await processOrder(b),'confirmed');
 assert.equal((await reconcile()).confirmed,500);await reset();
});
test('payment decline and reservation timeout return stock; expired units can sell',async()=>{
 const decline=await seed(100,'decline'),timeout=await seed(400,'timeout');
 await processOrder(decline);await processOrder(timeout);await sleep(25);
 assert.equal(await processOrder(decline),'failed');assert.equal((await reconcile()).available,100);
 await sleep(350);assert.equal(await reapExpired(),1);assert.equal(await processOrder(timeout),'expired');assert.equal((await reconcile()).available,500);
 const replacement=await seed(500);await processOrder(replacement);await sleep(25);assert.equal(await processOrder(replacement),'confirmed');await reset();
});
test('Redis atomic multi-unit leases bound admission and expire',async()=>{
 const ids=Array.from({length:110},()=>randomUUID());const rs=await Promise.all(ids.map(id=>admit(id,5)));
 assert.equal(rs.filter(x=>x===1).length,100);assert.equal(await admit(ids[0],5),1);assert.equal(await admit(ids[0],4),-1);
 await sleep(375);assert.equal(await admit(randomUUID(),500),1);await reset();
});
test('HTTP to durable inbox, RabbitMQ relay, worker and status; duplicates and validation',async()=>{
 child('src/server.js');
 await eventually(async()=>{assert.equal((await fetch('http://127.0.0.1:3100/health/ready')).status,200);});
 const checkout=(body,key=randomUUID())=>fetch('http://127.0.0.1:3100/api/checkout',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(body)});
 assert.equal((await checkout({quantity:0})).status,400);
 const key=randomUUID();const responses=await Promise.all(Array.from({length:12},()=>checkout({quantity:7},key)));
 assert.ok(responses.every(r=>r.status===202));const orders=await Promise.all(responses.map(r=>r.json()));
 assert.equal(new Set(orders.map(o=>o.orderId)).size,1);
 assert.equal((await checkout({quantity:8},key)).status,409);
 // Accepted while no relay or worker is running: durable backlog, not a success claim.
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n,1);
 child('src/relay.js');child('src/worker.js');
 const o=orders[0];const status=()=>fetch('http://127.0.0.1:3100/api/orders/'+o.orderId,{headers:{Authorization:'Bearer '+o.statusToken}});
 await eventually(async()=>{const r=await status();assert.equal((await r.json()).state,'confirmed');});
 assert.equal((await reconcile()).confirmed,7);
 assert.equal((await fetch('http://127.0.0.1:3100/api/orders/'+o.orderId)).status,404);
 assert.equal((await checkout({quantity:7},key)).status,200);
 assert.equal((await fetch('http://127.0.0.1:3100/')).status,200);
});
