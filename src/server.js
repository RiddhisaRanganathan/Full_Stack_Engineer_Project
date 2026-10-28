import express from 'express';
import {fileURLToPath} from 'node:url';
import {pool} from './db.js';
import {config,log} from './config.js';
import {redis,admit,release,rateLimit} from './admission.js';
import {validate,identity,existing,enqueue,view,digest} from './orders.js';
export const app=express();
app.disable('x-powered-by');
// Only trust the single Nginx hop in Compose; direct local requests default to no trust.
app.set('trust proxy',process.env.TRUST_PROXY==='1'?1:false);
app.use(express.json({limit:'2kb'}));
app.use((req,res,next)=>{res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'"});next();});
app.get('/health/live',(_req,res)=>res.json({ok:true}));
app.get('/health/ready',async(_req,res)=>{try{await pool.query('SELECT 1');await redis.ping();res.json({ok:true});}catch{res.status(503).json({ok:false});}});
app.get('/api/product',async(_req,res)=>{
 const {rows:[stock]}=await pool.query('SELECT available,reserved,confirmed FROM inventory WHERE id=1');
 res.set('Cache-Control','public, max-age=0, s-maxage=1').json({name:'Festival Phone',price:49900,currency:'INR',total:500,...stock,saleStart:config.saleStart,serverTime:new Date().toISOString()});
});
app.post('/api/checkout',async(req,res,next)=>{
 let lease;
 try {
  const body=validate(req.body||{}),key=req.get('Idempotency-Key');
  if(!key||!/^[A-Za-z0-9_-]{16,128}$/.test(key))return res.status(400).json({error:'Supply a 16–128 character Idempotency-Key'});
  const i=identity(key,body);
  // Retry lookup before sale/rate/stock gates, including after sale ends.
  let o=await existing(key,i.hash);
  if(!o) {
   if(Date.now()<Date.parse(config.saleStart))return res.status(425).json({error:'Sale has not opened'});
   if(!await rateLimit(digest(req.ip)))return res.set('Retry-After','10').status(429).json({error:'Rate limited; retry the same request'});
   // Key-derived lease avoids duplicate submissions consuming multiple provisional tokens.
   lease=digest(key);
   const admitted=await admit(lease,body.quantity);
   if(admitted===-1)return res.status(409).json({error:'Conflicting provisional quantity'});
   if(!admitted)return res.set('Retry-After','2').status(503).json({error:'Admission busy; request not accepted'});
   o=await enqueue(key,body,i);
  }
  res.set({'Location':`/api/orders/${o.id}`,'Cache-Control':'no-store'}).status(['queued','reserved'].includes(o.state)?202:200).json({...view(o),statusToken:o.status_token,accepted:true});
 }catch(e){next(e);}
 finally {if(lease)await release(lease).catch(e=>log('lease_release_deferred',{message:e.message}));}
});
app.get('/api/orders/:id',async(req,res)=>{
 if(!/^[0-9a-f-]{36}$/i.test(req.params.id))return res.status(404).json({error:'Order not found'});
 const {rows:[o]}=await pool.query('SELECT * FROM orders WHERE id=$1 AND status_token=$2',[req.params.id,req.get('Authorization')?.replace(/^Bearer /,'')||'']);
 if(!o)return res.status(404).json({error:'Order not found'});
 res.set('Cache-Control','no-store').json(view(o));
});
app.use(express.static(fileURLToPath(new URL('../public',import.meta.url)),{maxAge:0}));
app.use((err,req,res,_next)=>{
 log('request_error',{path:req.path,message:err.message});
 const status=err.status||503;
 res.set('Retry-After','2').status(status).json({error:status===503?'Temporarily unavailable; retry with the same idempotency key':err.message});
});
await redis.connect();
const server=app.listen(config.port,()=>log('api_started',{port:config.port}));
server.requestTimeout=10000;server.headersTimeout=12000;server.keepAliveTimeout=5000;server.maxConnections=2000;
async function stop(){server.close(async()=>{await redis.quit();await pool.end();process.exit(0);});setTimeout(()=>process.exit(1),10000).unref();}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
