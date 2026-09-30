/** The token in an "Authorization: Bearer <token>" header value, or null. */
export const extractBearerToken = (header: string | undefined) => {
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
};
