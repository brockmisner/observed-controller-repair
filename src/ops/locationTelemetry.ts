import { randomUUID } from "node:crypto";
import type { LocationRequest, Prisma } from "@prisma/client";
import { z } from "zod";
import { gpsRejectionDetailText, gpsRejectionMessage, gpsRejectionReasonSchema, type GpsRejectionReason, type SafeGpsRejectionDetail } from "../api/gpsRejectionReason.js";
import { prisma } from "../db.js";
import { haversineMeters } from "../geo/haversine.js";
import { HttpError } from "../http/errors.js";
import { logger } from "../logger.js";

const coordinates = { lat: z.number().finite().min(-90).max(90), lng: z.number().finite().min(-180).max(180) };
const duration = z.number().finite().nonnegative();
const timestamp = z.date().refine((value) => Number.isFinite(value.getTime()), "Invalid timestamp");
const identifier = z.string().min(1).max(200).refine((value) => value.trim() === value && !/[\x00-\x1f\x7f-\x9f]/.test(value));
const sources = z.enum(["JITTER", "WAKE", "QUEUE", "DRIVE", "SITE", "ANCHOR"]);
const completionStatuses = z.enum(["API_ACCEPTED", "API_REJECTED", "UNCONFIRMED", "FAILED", "SKIPPED", "DRY_RUN"]);

export type LocationRequestSource = z.infer<typeof sources>;
export type LocationCompletionStatus = z.infer<typeof completionStatuses>;

const observationInputSchema = z.object({
  source: z.enum(["MANUAL_ADB", "DIAGNOSTIC_APK"]),
  ...coordinates,
  fixElapsedRealtimeMs: duration.max(Number.MAX_SAFE_INTEGER),
  deviceElapsedRealtimeMs: duration.max(Number.MAX_SAFE_INTEGER),
  capturedAt: z.string().datetime({ offset: true }),
  horizontalAccuracyM: duration,
  hasSpeed: z.boolean(),
  speedMps: duration.optional(),
  speedAccuracyMps: duration.optional(),
  hasBearing: z.boolean().optional(),
  bearingDegrees: z.number().finite().min(0).lt(360).optional(),
  hasAltitude: z.boolean().optional(),
  altitudeM: z.number().finite().optional(),
}).strict().superRefine((value, context) => {
  if (value.hasSpeed && value.speedMps === undefined || !value.hasSpeed && (value.speedMps !== undefined || value.speedAccuracyMps !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["hasSpeed"], message: "Speed values must agree with hasSpeed" });
  }
  if (value.hasBearing === true && value.bearingDegrees === undefined || value.hasBearing === false && value.bearingDegrees !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["hasBearing"], message: "Bearing must agree with hasBearing" });
  }
  if (value.hasAltitude === true && value.altitudeM === undefined || value.hasAltitude === false && value.altitudeM !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["hasAltitude"], message: "Altitude must agree with hasAltitude" });
  }
});

export type AndroidObservationInput = z.infer<typeof observationInputSchema>;
export type AndroidObservation = AndroidObservationInput & {
  fixAgeMs: number;
  distanceFromRequestedM: number;
  correlation: "TEMPORAL_ONLY";
};

function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, "Invalid location telemetry values");
  return result.data;
}

function requireStageTime(at: Date, earliest: Date): void {
  if (at.getTime() < earliest.getTime() || at.getTime() > Date.now() + 5000) {
    throw new HttpError(400, "Location stage timestamp is out of order or in the future");
  }
}

export function logLocationRequestStage(row: LocationRequest, phase = row.status): void {
  logger.info({
    requestId: row.id, deviceId: row.deviceId, tenantId: row.tenantId, imageId: row.imageId,
    source: row.source, lat: row.lat, lng: row.lng, phase, status: row.status, evidenceLevel: row.evidenceLevel,
    requestedAt: row.requestedAt, dispatchedAt: row.dispatchedAt, completedAt: row.completedAt,
    acceptedAt: row.acceptedAt, observedAt: row.observedAt,
    queueDelayMs: row.queueDelayMs, dispatchIntervalMs: row.dispatchIntervalMs, apiLatencyMs: row.apiLatencyMs,
    error: row.error,
    ...(phase === "ANDROID_OBSERVED" ? { correlation: "TEMPORAL_ONLY" } : {}),
  }, phase === "ANDROID_OBSERVED" ? "Android location observation recorded; temporal correlation is not causal proof" : "location request lifecycle");
}

export async function createLocationRequest(
  device: { id: string; tenantId: string; imageId: string },
  coords: { lat: number; lng: number },
  source: LocationRequestSource,
  tripId?: string,
): Promise<LocationRequest> {
  const identity = validate(z.object({ id: identifier, tenantId: identifier, imageId: identifier }), device);
  const point = validate(z.object(coordinates), coords);
  const requestSource = validate(sources, source);
  const row = await prisma.$transaction(async (tx) => {
    if (!await tx.device.findFirst({ where: identity, select: { id: true } })) throw new HttpError(404, "Device not found");
    if (tripId && !await tx.drivingTrip.findFirst({ where: { id: tripId, deviceId: identity.id, tenantId: identity.tenantId } })) {
      throw new HttpError(404, "Trip not found");
    }
    return tx.locationRequest.create({ data: {
      id: randomUUID(), deviceId: identity.id, tenantId: identity.tenantId, imageId: identity.imageId,
      lat: point.lat, lng: point.lng, source: requestSource, tripId, requestedAt: new Date(),
    } });
  });
  logLocationRequestStage(row, "REQUESTED");
  return row;
}

export async function markLocationDispatched(
  id: string,
  input: { at: Date; dispatchIntervalMs: number | null; queueDelayMs: number },
  transaction?: Prisma.TransactionClient,
): Promise<LocationRequest> {
  validate(identifier, id);
  const values = validate(z.object({ at: timestamp, dispatchIntervalMs: duration.nullable(), queueDelayMs: duration }).strict(), input);
  const mark = async (tx: Prisma.TransactionClient) => {
    const current = await tx.locationRequest.findUnique({ where: { id } });
    if (!current) throw new HttpError(404, "Location request not found");
    requireStageTime(values.at, current.requestedAt);
    const result = await tx.locationRequest.updateMany({
      where: { id, status: "REQUESTED", dispatchedAt: null, completedAt: null },
      data: { status: "DISPATCHED", dispatchedAt: values.at, dispatchIntervalMs: values.dispatchIntervalMs, queueDelayMs: values.queueDelayMs },
    });
    if (result.count !== 1) throw new HttpError(409, "Location request was already dispatched or completed");
    return tx.locationRequest.findUniqueOrThrow({ where: { id } });
  };
  const row = transaction ? await mark(transaction) : await prisma.$transaction(mark);
  if (!transaction) logLocationRequestStage(row, "DISPATCHED");
  return row;
}

const safeErrors: Record<Exclude<LocationCompletionStatus, "API_ACCEPTED" | "DRY_RUN">, string> = {
  API_REJECTED: "DuoPlus did not accept this device's GPS update.",
  UNCONFIRMED: "DuoPlus acceptance could not be confirmed.",
  FAILED: "The location request failed; provider acceptance is not established.",
  SKIPPED: "The GPS update was skipped before dispatch.",
};

export async function completeLocationRequest(
  id: string,
  input: { status: LocationCompletionStatus; at: Date; apiLatencyMs: number | null; error?: string; rejectionReason?: GpsRejectionReason; rejectionDetail?: SafeGpsRejectionDetail },
  transaction?: Prisma.TransactionClient,
): Promise<LocationRequest> {
  validate(identifier, id);
  const values = validate(z.object({ status: completionStatuses, at: timestamp, apiLatencyMs: duration.nullable(),
    error: z.string().optional(), rejectionReason: gpsRejectionReasonSchema.optional(),
    rejectionDetail: z.custom<SafeGpsRejectionDetail>((value) => gpsRejectionDetailText(value) !== undefined).optional(),
  }).strict().refine((value) => value.status === "API_REJECTED" || value.rejectionReason === undefined && value.rejectionDetail === undefined), input);
  const complete = async (tx: Prisma.TransactionClient) => {
    const current = await tx.locationRequest.findUnique({ where: { id } });
    if (!current) throw new HttpError(404, "Location request not found");
    requireStageTime(values.at, current.dispatchedAt ?? current.requestedAt);
    if (values.rejectionDetail && gpsRejectionDetailText(values.rejectionDetail, current.imageId) === undefined) {
      throw new HttpError(400, "Provider rejection detail belongs to another device");
    }
    const requiresDispatch = ["API_ACCEPTED", "API_REJECTED", "UNCONFIRMED"].includes(values.status);
    if (requiresDispatch && !current.dispatchedAt || ["SKIPPED", "DRY_RUN"].includes(values.status) && current.dispatchedAt) {
      throw new HttpError(409, "Location completion does not match its dispatch stage");
    }
    if (!current.dispatchedAt && values.apiLatencyMs !== null) throw new HttpError(400, "Undispatched requests have no API latency");
    const safeError = values.status === "API_REJECTED" && values.rejectionReason ? gpsRejectionMessage(values.rejectionReason) :
      values.status in safeErrors ? safeErrors[values.status as keyof typeof safeErrors] : null;
    const detail = gpsRejectionDetailText(values.rejectionDetail);
    const error = detail ? `${safeError} Provider detail: ${detail}` : safeError;
    const result = await tx.locationRequest.updateMany({
      where: { id, status: { in: ["REQUESTED", "DISPATCHED"] }, completedAt: null },
      data: {
        status: values.status, evidenceLevel: values.status === "API_ACCEPTED" ? "API_ACCEPTED" : "REQUESTED",
        completedAt: values.at, acceptedAt: values.status === "API_ACCEPTED" ? values.at : null,
        apiLatencyMs: values.apiLatencyMs, error, rejectionReason: values.rejectionReason ?? null,
      },
    });
    if (result.count !== 1) throw new HttpError(409, "Location request was already completed");
    return tx.locationRequest.findUniqueOrThrow({ where: { id } });
  };
  const row = transaction ? await complete(transaction) : await prisma.$transaction(complete);
  if (!transaction) logLocationRequestStage(row, values.status);
  return row;
}

export async function getLocationTelemetry(deviceId: string, limit = 20): Promise<LocationRequest[]> {
  validate(identifier, deviceId);
  const take = validate(z.number().int().min(1).max(50), limit);
  return prisma.locationRequest.findMany({ where: { deviceId }, orderBy: [{ requestedAt: "desc" }, { id: "desc" }], take });
}

export async function recordAndroidObservation(deviceId: string, requestId: string, input: unknown): Promise<LocationRequest> {
  validate(identifier, deviceId);
  validate(identifier, requestId);
  const observation = validate(observationInputSchema, input);
  const capturedAt = new Date(observation.capturedAt);
  const fixAgeMs = observation.deviceElapsedRealtimeMs - observation.fixElapsedRealtimeMs;
  if (fixAgeMs < 0 || fixAgeMs > 30_000 || capturedAt.getTime() < Date.now() - 30_000 || capturedAt.getTime() > Date.now() + 5000) {
    throw new HttpError(400, "Android observation must contain a fresh fix and a recent capture time");
  }
  const row = await prisma.$transaction(async (tx) => {
    const current = await tx.locationRequest.findFirst({ where: { id: requestId, deviceId } });
    if (!current) throw new HttpError(404, "Location request not found for this device");
    if (!current.dispatchedAt || !current.acceptedAt || current.status !== "API_ACCEPTED") {
      throw new HttpError(409, "Android observation requires an API-accepted location request");
    }
    if (capturedAt.getTime() < current.dispatchedAt.getTime()) throw new HttpError(409, "Android observation predates this request's dispatch");
    const stored: AndroidObservation = {
      ...observation, capturedAt: capturedAt.toISOString(), fixAgeMs,
      distanceFromRequestedM: haversineMeters(current.lat, current.lng, observation.lat, observation.lng),
      correlation: "TEMPORAL_ONLY",
    };
    // The supersession check is part of the write, not a separate stale read.
    const result = await tx.locationRequest.updateMany({
      where: {
        id: requestId, deviceId, status: "API_ACCEPTED", acceptedAt: { not: null }, androidObservationJson: null,
        device: { locationRequests: { none: { id: { not: requestId }, dispatchedAt: { gte: current.dispatchedAt } } } },
      },
      data: { evidenceLevel: "ANDROID_OBSERVED", observedAt: capturedAt, androidObservationJson: JSON.stringify(stored) },
    });
    if (result.count !== 1) throw new HttpError(409, "Location request already has an observation or was superseded by another dispatch");
    return tx.locationRequest.findUniqueOrThrow({ where: { id: requestId } });
  });
  logLocationRequestStage(row, "ANDROID_OBSERVED");
  return row;
}

export function serializeLocationRequest(record: LocationRequest) {
  const { androidObservationJson, ...row } = record;
  let androidObservation: AndroidObservation | null = null;
  if (androidObservationJson) {
    try {
      const parsed = JSON.parse(androidObservationJson) as AndroidObservation;
      const { fixAgeMs, distanceFromRequestedM, correlation, ...input } = parsed;
      const observation = observationInputSchema.safeParse(input);
      if (observation.success && Number.isFinite(fixAgeMs) && fixAgeMs >= 0 && fixAgeMs <= 30_000 &&
          Number.isFinite(distanceFromRequestedM) && distanceFromRequestedM >= 0 && correlation === "TEMPORAL_ONLY") {
        androidObservation = { ...observation.data, fixAgeMs, distanceFromRequestedM, correlation };
      }
    } catch { /* Malformed saved evidence must not become a device-observed claim. */ }
  }
  return {
    ...row,
    evidenceLevel: row.evidenceLevel === "ANDROID_OBSERVED" && !androidObservation ? row.acceptedAt ? "API_ACCEPTED" : "REQUESTED" : row.evidenceLevel,
    requestedAt: row.requestedAt.toISOString(), dispatchedAt: row.dispatchedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null, acceptedAt: row.acceptedAt?.toISOString() ?? null,
    observedAt: androidObservation ? row.observedAt?.toISOString() ?? null : null,
    androidObservation,
  };
}
