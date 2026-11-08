(process.env as Record<string, string>).NODE_ENV = "test";
process.env.DATABASE_URL = "postgres://pinpulse_app:pinpulse_app@localhost:5432/pinpulse_test";
process.env.DATABASE_OWNER_URL = "postgres://postgres:dev@localhost:5432/pinpulse_test";
process.env.INTEGRITY_ALLOW_PRIVATE_HOSTS = "true";
