import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { config } from "../config";

export type UserRole = "user" | "admin" | "platform";

export interface TokenPayload extends JWTPayload {
  sub: string;       // user id
  email: string;
  username: string;
  role: UserRole;
}

const accessSecret = new TextEncoder().encode(config.jwt.accessSecret);
const refreshSecret = new TextEncoder().encode(config.jwt.refreshSecret);

export async function signAccessToken(payload: Omit<TokenPayload, "iat" | "exp">): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(config.jwt.accessExpiresIn)
    .sign(accessSecret);
}

export async function signRefreshToken(payload: Omit<TokenPayload, "iat" | "exp">): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(config.jwt.refreshExpiresIn)
    .sign(refreshSecret);
}

export async function verifyAccessToken(token: string): Promise<TokenPayload> {
  const { payload } = await jwtVerify(token, accessSecret);
  return payload as TokenPayload;
}

export async function verifyRefreshToken(token: string): Promise<TokenPayload> {
  const { payload } = await jwtVerify(token, refreshSecret);
  return payload as TokenPayload;
}
