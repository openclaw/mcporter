export function toAsciiSlug(value: string): string {
  let slug = '';
  let pendingSeparator = false;

  for (const character of value.trim().toLowerCase()) {
    const code = character.charCodeAt(0);
    const isLetter = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    if (isLetter || isDigit) {
      if (pendingSeparator && slug.length > 0) {
        slug += '-';
      }
      slug += character;
      pendingSeparator = false;
    } else if (slug.length > 0) {
      pendingSeparator = true;
    }
  }

  return slug;
}
