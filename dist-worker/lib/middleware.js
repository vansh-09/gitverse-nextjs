"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HttpError = void 0;
exports.getAuthUser = getAuthUser;
exports.requireAuth = requireAuth;
exports.isHttpError = isHttpError;
const auth_1 = require("./auth");
function getAuthUser(request) {
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return null;
    }
    const token = authHeader.substring(7);
    return (0, auth_1.verifyToken)(token);
}
function requireAuth(request) {
    const user = getAuthUser(request);
    if (!user) {
        throw new HttpError(401, "Unauthorized");
    }
    return user;
}
class HttpError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
exports.HttpError = HttpError;
function isHttpError(error) {
    return (typeof error === "object" &&
        error !== null &&
        "status" in error &&
        typeof error.status === "number");
}
