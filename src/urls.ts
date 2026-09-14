/** Only absolute web links may cross the feed-to-browser boundary. */
export function safeLink(value: string): string {
  if (
    [...value].some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    ) ||
    Buffer.byteLength(value, 'utf8') > 2048
  )
    return '';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    const normalized = url.href;
    return Buffer.byteLength(normalized, 'utf8') <= 2048 ? normalized : '';
  } catch {
    return '';
  }
}
