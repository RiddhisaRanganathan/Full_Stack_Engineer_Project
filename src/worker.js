import {pool} from './db.js';
import {connectBroker,QUEUE} from './broker.js';
import {processOrder,failAttempt,reconcile,reapExpired} from './orders.js';
import {config,delay,log} from './config.js';
let stop=false,broker,inflight=0,reaping=false;
const expiry=setInterval(async()=>{if(reaping)return;reaping=true;try{await reapExpired();}catch(e){log('expiry_retry',{message:e.message});}finally{reaping=false;}},500);
process.on('SIGTERM',()=>{stop=true;});process.on('SIGINT',()=>{stop=true;});
const audit=setInterval(()=>reconcile().catch(e=>{log('reconciliation_failed',{message:e.message});if(e.message.startsWith('INVENTORY'))stop=true;}),5000);
while(!stop) {
 try {
  broker=await connectBroker();
  await broker.ch.prefetch(config.concurrency);
  const active=broker;
  const consumer=await active.ch.consume(QUEUE,async msg=>{
   if(!msg)return;
   inflight++;
   let id;
   try {
    id=JSON.parse(msg.content.toString()).orderId;
    if(typeof id!=='string'||!/^[0-9a-f-]{36}$/i.test(id)){active.ch.nack(msg,false,false);return;}
    const state=await processOrder(id);
    log('order_processed',{orderId:id,state});
    active.ch.ack(msg); // Only after database COMMIT; duplicates are harmless.
   } catch(e) {
    log('worker_error',{orderId:id,message:e.message});
    // Database dispatch remains due if even this transaction fails. Avoid hot nack loops.
    if(id)await failAttempt(id,e.message).catch(()=>{});
    try{active.ch.nack(msg,false,false);}catch{}
   } finally {inflight--;}
  });
  await new Promise(resolve=>{broker.conn.once('close',resolve);const t=setInterval(()=>{if(stop){clearInterval(t);active.ch.cancel(consumer.consumerTag).catch(()=>{}).finally(resolve);}},200);broker.conn.once('close',()=>clearInterval(t));});
 }catch(e){log('worker_reconnect',{message:e.message});await delay(1000+Math.random()*1000);}
}
clearInterval(audit);clearInterval(expiry);
while(inflight)await delay(100);
if(broker)await broker.conn.close().catch(()=>{});await pool.end();
