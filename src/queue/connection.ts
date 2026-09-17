import { Redis } from "ioredis";
import { config } from "../config.js";
import { producerRedisOptions } from "./redisOptions.js";

export function createRedis(): Redis {
  if (config.redisUrl) {
    return new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  }
  return new Redis({
    host: config.redisHost,
    port: config.redisPort,
    password: config.redisPassword,
    maxRetriesPerRequest: null,
  });
}

export const redisConnection = createRedis();

export const producerConnection = config.redisUrl
  ? new Redis(config.redisUrl, producerRedisOptions)
  : new Redis({ host: config.redisHost, port: config.redisPort, password: config.redisPassword, ...producerRedisOptions });
