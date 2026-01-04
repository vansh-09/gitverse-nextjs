"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.prisma = void 0;
exports.getPrisma = getPrisma;
const client_1 = require("@prisma/client");
const pg_1 = require("pg");
const adapter_pg_1 = require("@prisma/adapter-pg");
function createPrismaClient() {
    const connectionString = process.env.DATABASE_URL;
    // IMPORTANT: Prisma Client is configured to use the "client" engine (driver adapters).
    // Instantiating PrismaClient without an adapter will throw.
    // We intentionally defer instantiation until runtime so builds don't require secrets.
    if (!connectionString) {
        throw new Error("DATABASE_URL is required");
    }
    const pool = new pg_1.Pool({
        connectionString,
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 30000,
        max: 20,
        min: 2,
    });
    pool.on("error", (err) => {
        console.error("Unexpected pool error:", err);
    });
    const adapter = new adapter_pg_1.PrismaPg(pool);
    return new client_1.PrismaClient({
        adapter,
        log: ["error", "warn"],
    });
}
// Prevent multiple instances in development
const globalForPrisma = globalThis;
function getPrisma() {
    if (globalForPrisma.prisma)
        return globalForPrisma.prisma;
    const created = createPrismaClient();
    if (process.env.NODE_ENV !== "production")
        globalForPrisma.prisma = created;
    return created;
}
const prisma = new Proxy({}, {
    get(_target, prop) {
        const client = getPrisma();
        return client[prop];
    },
});
exports.prisma = prisma;
exports.default = prisma;
