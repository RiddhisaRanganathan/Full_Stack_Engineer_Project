import {createClient} from 'redis';
import {config,log} from './config.js';
export const redis=createClient({url:config.redis,socket:{connectTimeout:2000,reconnectStrategy: n=>Math.min(n*200,2000)},disableOfflineQueue:true,commandsQueueMaxLength:1000});
redis.on('error',e=>log('redis_error',{message:e.message}));
// Same hash tag: every key is on one Redis Cluster slot. Atomic and bounded at 500 units.
const acquire=`
local expired=redis.call('ZRANGEBYSCORE',KEYS[1],'-inf',ARGV[1])
for _,id in ipairs(expired) do redis.call('HDEL',KEYS[2],id); redis.call('ZREM',KEYS[1],id) end
local existing=redis.call('HGET',KEYS[2],ARGV[2])
if existing then return tonumber(existing)==tonumber(ARGV[3]) and 1 or -1 end
local used=0
for _,q in ipairs(redis.call('HVALS',KEYS[2])) do used=used+tonumber(q) end
if used+tonumber(ARGV[3])>500 then return 0 end
redis.call('HSET',KEYS[2],ARGV[2],ARGV[3])
redis.call('ZADD',KEYS[1],tonumber(ARGV[1])+tonumber(ARGV[4]),ARGV[2])
return 1`;
export async function admit(id,q) {
 return Number(await redis.withCommandOptions({abortSignal:AbortSignal.timeout(1500)}).eval(acquire,{keys:['{sale}:leases','{sale}:quantities'],arguments:[String(Date.now()),id,String(q),String(config.ttlMs)]}));
}
export async function release(id) {
 await redis.withCommandOptions({abortSignal:AbortSignal.timeout(1500)}).eval("redis.call('ZREM',KEYS[1],ARGV[1]); redis.call('HDEL',KEYS[2],ARGV[1]); return 1",{keys:['{sale}:leases','{sale}:quantities'],arguments:[id]});
}
export async function rateLimit(identity) {
 return Number(await redis.withCommandOptions({abortSignal:AbortSignal.timeout(1500)}).eval("local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],10) end; return n",{keys:[`{rate}:${identity}:${Math.floor(Date.now()/10000)}`],arguments:[]}))<=config.rateLimit;
}
