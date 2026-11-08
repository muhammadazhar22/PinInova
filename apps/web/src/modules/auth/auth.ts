import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { env } from "@/env";
import { authOptions } from "./options";

const e = env();
const base = authOptions(e.DATABASE_URL, e.APP_URL, e.BETTER_AUTH_SECRET);

export const auth = betterAuth({ ...base, plugins: [...(base.plugins ?? []), nextCookies()] });
export type Session = typeof auth.$Infer.Session;
