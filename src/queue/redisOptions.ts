import type { RedisOptions } from "ioredis";

// Workers must reconnect indefinitely. HTTP producers must never retain an
// abandoned command to send later; the database outbox owns intentional retries.
export const producerRedisOptions: RedisOptions = {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  autoResendUnfulfilledCommands: false,
  connectTimeout: 2000,
  commandTimeout: 3000,
};
