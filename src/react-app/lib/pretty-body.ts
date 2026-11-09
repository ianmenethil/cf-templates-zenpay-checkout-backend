/**
 * Indents a JSON object or array so it can be read; any other body comes back as it arrived.
 * @param body - The callback body as text.
 * @returns The indented JSON for an object or array; `body` unchanged for a scalar, `null`, or text that is not JSON.
 */
export const prettyBody = (body: string): string => {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null ? JSON.stringify(parsed, null, 2) : body;
  } catch {
    return body;
  }
};
