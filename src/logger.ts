import pino from "pino";
import { config } from "./config.js";

export const logger = pino({
  level: config.logLevel,
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: "observatory-controller" },
});
