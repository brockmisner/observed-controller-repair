import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { HttpError } from "../http/errors.js";
import { hashPassword, hashToken, verifyPassword } from "./crypto.js";

const COOKIE = "obs_session";

export interface AuthContext {
  userId: string;
  tenantId: string;
  email: string;
  tenantName: string;
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie ?? "";
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k) {
      try { out[k] = decodeURIComponent(rest.join("=")); } catch { /* Ignore malformed cookies. */ }
    }
  }
  return out;
}

export async function registerAccount(email: string, password: string, workspace: string) {
  const normalizedEmail = email.trim().toLowerCase();
  const passwordHash = await hashPassword(password);
  const tenant = await prisma.tenant.create({
    data: {
      id: randomUUID(), name: workspace.trim() || normalizedEmail,
      users: { create: { id: randomUUID(), email: normalizedEmail, passwordHash } },
    },
    include: { users: true },
  });
  return { user: tenant.users[0]!, tenant };
}

export async function login(email: string, password: string): Promise<{ token: string; ctx: AuthContext }> {
  const user = await prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
    include: { tenant: true },
  });
  if (!user || !await verifyPassword(password, user.passwordHash)) {
    throw new HttpError(401, "Invalid email or password");
  }
  const token = randomBytes(32).toString("hex");
  await prisma.session.create({
    data: {
      id: randomUUID(),
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });
  return {
    token,
    ctx: { userId: user.id, tenantId: user.tenantId, email: user.email, tenantName: user.tenant.name },
  };
}

export async function logout(req: IncomingMessage): Promise<void> {
  const token = parseCookies(req)[COOKIE];
  if (!token) return;
  await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}

export async function readAuth(req: IncomingMessage): Promise<AuthContext | null> {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { include: { tenant: true } } },
  });
  if (!session || session.expiresAt < new Date()) return null;
  return {
    userId: session.user.id,
    tenantId: session.user.tenantId,
    email: session.user.email,
    tenantName: session.user.tenant.name,
  };
}

export function setSessionCookie(res: ServerResponse, token: string): void {
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}${config.production ? "; Secure" : ""}`);
}

export function clearSessionCookie(res: ServerResponse): void {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${config.production ? "; Secure" : ""}`);
}
