import { createHmac, timingSafeEqual } from "node:crypto";

export type Role = "user" | "admin" | "service";
export interface Principal { sub: string; role: Role }
export class AuthError extends Error {}

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
export const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Verifies an HS256 JWT. Algorithm is pinned (no `alg` negotiation); exp, iss and aud are mandatory. */
export function verifyJwt(token: string, o: { secret: string; issuer: string; audience: string; now?: number }): Principal {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError("malformed token");
  const [h, p, sig] = parts;
  let header: any, claims: any;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString());
    claims = JSON.parse(Buffer.from(p, "base64url").toString());
  } catch { throw new AuthError("malformed token"); }
  if (header.alg !== "HS256" || header.typ !== undefined && header.typ !== "JWT") throw new AuthError("unsupported alg");
  const expect = createHmac("sha256", o.secret).update(`${h}.${p}`).digest("base64url");
  if (!safeEqual(expect, sig)) throw new AuthError("bad signature");
  const now = Math.floor((o.now ?? Date.now()) / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= now) throw new AuthError("expired");
  if (typeof claims.nbf === "number" && claims.nbf > now + 30) throw new AuthError("not yet valid");
  if (claims.iss !== o.issuer) throw new AuthError("bad issuer");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(o.audience)) throw new AuthError("bad audience");
  if (typeof claims.sub !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(claims.sub)) throw new AuthError("bad subject");
  const role: Role = claims.role === "admin" || claims.role === "service" ? claims.role : "user";
  return { sub: claims.sub, role };
}

/** Test/dev helper; production tokens are minted by the identity service, not this service. */
export function signJwt(claims: object, secret: string): string {
  const h = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64u(JSON.stringify(claims));
  return `${h}.${p}.${createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url")}`;
}
