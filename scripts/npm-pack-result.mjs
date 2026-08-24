export function parseSingleNpmPackResult(stdout) {
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch (error) {
    throw new Error("npm pack did not emit machine-readable JSON", {
      cause: error,
    });
  }

  const results = Array.isArray(envelope)
    ? envelope
    : isRecord(envelope)
      ? Object.values(envelope)
      : [];
  if (results.length !== 1 || !isRecord(results[0])) {
    throw new TypeError("npm pack returned an invalid result envelope");
  }
  return results[0];
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
