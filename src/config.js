export const config = {
 port: Number(process.env.PORT || 3000),
 database: process.env.DATABASE_URL || 'postgres://flash:flash_local@127.0.0.1:5432/flash',
 redis: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
 amqp: process.env.AMQP_URL || 'amqp://flash:flash_local@127.0.0.1:5672',
 saleStart: process.env.SALE_START || '2026-10-28T14:30:00Z',
 ttlMs: Number(process.env.RESERVATION_TTL_MS || 30000),
 paymentMs: Number(process.env.PAYMENT_DELAY_MS || 1500),
 concurrency: Number(process.env.WORKER_CONCURRENCY || 8),
 queueLimit: Number(process.env.QUEUE_LIMIT || 2000),
 poolMax: Number(process.env.DB_POOL_MAX || 12),
 maxAttempts: Number(process.env.MAX_ATTEMPTS || 8),
 rateLimit: Number(process.env.RATE_LIMIT || 20),
};
export function log(event, fields={}) { console.log(JSON.stringify({time:new Date().toISOString(),event,...fields})); }
export const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));

for (const k of ['port','ttlMs','paymentMs','concurrency','queueLimit','poolMax','maxAttempts','rateLimit']) {
 if (!Number.isSafeInteger(config[k]) || config[k] < 1) throw new Error('Invalid positive integer configuration: '+k);
}
if (!Number.isFinite(Date.parse(config.saleStart))) throw new Error('SALE_START must be a valid ISO date');
