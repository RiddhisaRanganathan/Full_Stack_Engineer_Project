import amqp from 'amqplib';
import {config,log} from './config.js';
export const QUEUE='checkout', DLQ='checkout.dead';
export async function connectBroker() {
 const conn=await amqp.connect(config.amqp,{timeout:3000});
 conn.on('error',e=>log('broker_error',{message:e.message}));
 const ch=await conn.createConfirmChannel();
 ch.on('error',e=>log('channel_error',{message:e.message}));
 await ch.assertQueue(DLQ,{durable:true,arguments:{'x-queue-type':'quorum'}});
 await ch.assertQueue(QUEUE,{durable:true,arguments:{'x-queue-type':'quorum','x-max-length':config.queueLimit,'x-overflow':'reject-publish','x-dead-letter-exchange':'','x-dead-letter-routing-key':DLQ}});
 return {conn,ch};
}
export function publish(ch,id) {
 return new Promise((resolve,reject)=>ch.sendToQueue(QUEUE,Buffer.from(JSON.stringify({orderId:id})),{persistent:true,messageId:id,contentType:'application/json'},e=>e?reject(e):resolve()));
}
