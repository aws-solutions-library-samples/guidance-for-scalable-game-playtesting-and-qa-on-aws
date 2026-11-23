import { ApiError } from "aws-amplify/api";

/**
 * Pull a readable message out of an Amplify API error so it can be shown to the user.
 * The backend returns its message as a JSON-encoded string or as a {message} object.
 */
export function apiErrorMessage(error: unknown, fallback: string): string {
    const body = error instanceof ApiError ? error.response?.body : undefined;
    if (body) {
        try {
            const parsed = JSON.parse(body);
            if (typeof parsed === "string" && parsed.trim()) return parsed;
            if (parsed && typeof parsed.message === "string") return parsed.message;
        } catch {
            if (body.trim()) return body;
        }
    }
    return fallback;
}
