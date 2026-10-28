import {transaction,pool} from './db.js';
import {connectBroker,publish} from './broker.js';
import {config,delay,log} from './config.js';
let stopping=false,broker;
process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
while(!stopping) {
 try {
  if(!broker){broker=await connectBroker();broker.conn.on('close',()=>{broker=null;});}
  // A durable dispatch row is retained until terminal status. Confirm before advancing its timer.
  // Bounded rows + SKIP LOCKED allow multiple relays without a hot global lock.
  const count=await transaction(async c=>{
   await c.query("DELETE FROM dispatch d USING orders o WHERE d.order_id=o.id AND o.state NOT IN ('queued','reserved')");
   const {rows}=await c.query(`SELECT d.order_id FROM dispatch d JOIN orders o ON o.id=d.order_id
    WHERE d.next_publish_at<=now() AND o.next_attempt_at<=now() AND o.state IN ('queued','reserved')
    ORDER BY d.next_publish_at LIMIT 20 FOR UPDATE OF d SKIP LOCKED`);
   for(const row of rows){await publish(broker.ch,row.order_id);await c.query("UPDATE dispatch SET publishes=publishes+1,next_publish_at=now()+interval '2 seconds' WHERE order_id=$1",[row.order_id]);}
   return rows.length;
  });
  if(!count)await delay(100);
 } catch(e) {log('relay_retry',{message:e.message});if(broker)await broker.conn.close().catch(()=>{});broker=null;await delay(1000+Math.random()*1000);}
}
if(broker)await broker.conn.close().catch(()=>{});await pool.end();
