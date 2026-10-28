// No dependencies. Runs against a disposable sale; does not claim a production benchmark.
import {randomUUID} from 'node:crypto';
const base=process.env.BASE_URL||'http://127.0.0.1:8080';
const total=Number(process.env.REQUESTS||1000),concurrency=Number(process.env.CONCURRENCY||100),quantity=Number(process.env.QUANTITY||1);
if(!Number.isSafeInteger(total)||total<1||!Number.isSafeInteger(concurrency)||concurrency<1)throw new Error('Positive integer REQUESTS and CONCURRENCY required');
const bins={},latencies=[];let next=0;const start=performance.now();
await Promise.all(Array.from({length:Math.min(total,concurrency)},async()=>{while(next++<total){const t=performance.now();try{const r=await fetch(base+'/api/checkout',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({quantity}),signal:AbortSignal.timeout(15000)});await r.arrayBuffer();bins[r.status]=(bins[r.status]||0)+1;}catch{bins.network_error=(bins.network_error||0)+1;}latencies.push(performance.now()-t);}}));
latencies.sort((a,b)=>a-b);const duration=(performance.now()-start)/1000;
console.log(JSON.stringify({requests:total,concurrency,seconds:duration,requestsPerSecond:total/duration,outcomes:bins,p50ms:latencies[Math.floor(latencies.length*.5)],p99ms:latencies[Math.min(latencies.length-1,Math.floor(latencies.length*.99))],note:'202 means durable acceptance, not confirmed sale. Closed-loop load; use multiple generators for 100k simultaneous connections.'},null,2));
